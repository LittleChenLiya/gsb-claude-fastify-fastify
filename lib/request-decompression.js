'use strict'

const zlib = require('node:zlib')
const { Transform } = require('node:stream')
const { kRequestPayloadStream } = require('./symbols')
const {
  FST_ERR_CTP_UNSUPPORTED_CONTENT_ENCODING,
  FST_ERR_CTP_INVALID_GZIP_BODY,
  FST_ERR_CTP_COMPRESSED_BODY_TOO_LARGE,
  FST_ERR_CTP_DECOMPRESSED_BODY_TOO_LARGE
} = require('./errors')

/**
 * Inspects the Content-Encoding header and, when it is 'gzip', replaces the
 * request payload stream with a stream that transparently decompresses the
 * body while enforcing the configured limits.
 *
 * Returns an error when the Content-Encoding is not supported, null otherwise.
 * Decompression failures are reported asynchronously through the replacement
 * stream so that they surface exactly like any other payload error.
 */
function setupRequestDecompression (request, limits) {
  const encoding = request.headers['content-encoding']

  if (encoding === undefined) {
    return null
  }

  const normalized = encoding.trim().toLowerCase()

  if (normalized === 'identity') {
    return null
  }

  // A single 'gzip' coding is the only supported encoding. Unknown codings
  // and multi-layer encodings (e.g. 'gzip, br') are rejected.
  if (normalized !== 'gzip') {
    return new FST_ERR_CTP_UNSUPPORTED_CONTENT_ENCODING(encoding)
  }

  const payload = request[kRequestPayloadStream] || request.raw
  const gunzip = zlib.createGunzip()

  let compressedLength = 0
  let decompressedLength = 0
  let finished = false

  // Counts the compressed bytes as they really flow in, regardless of what
  // the Content-Length header claims.
  const compressedCounter = new Transform({
    transform (chunk, encoding, callback) {
      compressedLength += chunk.length
      if (compressedLength > limits.compressedLimit) {
        callback(new FST_ERR_CTP_COMPRESSED_BODY_TOO_LARGE())
        return
      }
      callback(null, chunk)
    }
  })

  // Counts the decompressed bytes so that a gzip bomb is stopped as soon as
  // the configured output limit is exceeded.
  const output = new Transform({
    transform (chunk, encoding, callback) {
      decompressedLength += chunk.length
      if (decompressedLength > limits.decompressedLimit) {
        callback(new FST_ERR_CTP_DECOMPRESSED_BODY_TOO_LARGE())
        return
      }
      callback(null, chunk)
    }
  })

  payload.on('error', onPayloadError)
  payload.on('aborted', onPayloadAborted)
  payload.on('close', onPayloadClose)

  payload.pipe(compressedCounter).pipe(gunzip).pipe(output)

  compressedCounter.on('error', onPipelineError)
  gunzip.on('error', onGunzipError)
  output.on('error', cleanup)
  output.on('end', cleanup)

  // The decompressed body no longer matches the Content-Length of the
  // compressed payload, so the header must not be trusted downstream.
  delete request.headers['content-length']

  request[kRequestPayloadStream] = output

  return null

  function onPipelineError (err) {
    fail(err)
  }

  function onGunzipError () {
    fail(new FST_ERR_CTP_INVALID_GZIP_BODY())
  }

  function onPayloadError (err) {
    fail(err)
  }

  function onPayloadAborted () {
    fail(clientAbortedError())
  }

  function onPayloadClose () {
    if (payload.complete !== true) {
      fail(clientAbortedError())
    }
  }

  function fail (err) {
    if (finished === true) return
    finished = true
    cleanup()
    // Emitting the error on the replacement stream lets the regular payload
    // error handling reply once and close the connection as usual.
    output.destroy(err)
  }

  function cleanup () {
    payload.removeListener('error', onPayloadError)
    payload.removeListener('aborted', onPayloadAborted)
    payload.removeListener('close', onPayloadClose)
    compressedCounter.removeListener('error', onPipelineError)
    gunzip.removeListener('error', onGunzipError)
    output.removeListener('error', cleanup)
    output.removeListener('end', cleanup)

    payload.unpipe(compressedCounter)
    compressedCounter.unpipe(gunzip)
    gunzip.unpipe(output)

    compressedCounter.destroy()
    gunzip.destroy()
  }
}

function clientAbortedError () {
  const err = new Error('Client aborted the request')
  err.statusCode = 400
  return err
}

module.exports = { setupRequestDecompression }
