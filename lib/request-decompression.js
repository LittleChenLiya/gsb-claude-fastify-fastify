'use strict'

const zlib = require('node:zlib')
const { Transform } = require('node:stream')
const {
  FST_ERR_CTP_BODY_TOO_LARGE,
  FST_ERR_CTP_INVALID_CONTENT_ENCODING,
  FST_ERR_CTP_INVALID_GZIP_BODY,
  FST_ERR_ROUTE_DECOMPRESSION_OPTION_INVALID
} = require('./errors')

/**
 * Validates and normalizes a decompression route option or a
 * requestDecompression instance option.
 *
 * Returns null when decompression is disabled, otherwise an object with
 * the compressedLimit and decompressedLimit byte limits (Infinity when
 * a limit is not configured).
 */
function normalizeDecompressionOption (option) {
  if (option === undefined || option === null || option === false) {
    return null
  }

  if (option === true) {
    return { compressedLimit: Infinity, decompressedLimit: Infinity }
  }

  if (typeof option === 'object') {
    const { compressedLimit, decompressedLimit } = option
    if (
      (compressedLimit !== undefined && (!Number.isInteger(compressedLimit) || compressedLimit < 0)) ||
      (decompressedLimit !== undefined && (!Number.isInteger(decompressedLimit) || decompressedLimit < 0))
    ) {
      throw new FST_ERR_ROUTE_DECOMPRESSION_OPTION_INVALID(JSON.stringify(option))
    }
    return {
      compressedLimit: compressedLimit === undefined ? Infinity : compressedLimit,
      decompressedLimit: decompressedLimit === undefined ? Infinity : decompressedLimit
    }
  }

  throw new FST_ERR_ROUTE_DECOMPRESSION_OPTION_INVALID(typeof option)
}

/**
 * Resolves the effective decompression configuration for a route by
 * merging the route level option with the encapsulation scope default.
 */
function resolveRouteDecompression (routeOption, scopeOption) {
  if (routeOption === undefined) {
    return scopeOption
  }

  const routeConfig = normalizeDecompressionOption(routeOption)
  if (routeConfig === null || scopeOption === null) {
    return routeConfig
  }

  return {
    compressedLimit: routeConfig.compressedLimit === Infinity
      ? scopeOption.compressedLimit
      : routeConfig.compressedLimit,
    decompressedLimit: routeConfig.decompressedLimit === Infinity
      ? scopeOption.decompressedLimit
      : routeConfig.decompressedLimit
  }
}

/**
 * Returns the payload stream for the request, wrapping the raw stream with
 * a gunzip chain when the request carries a gzip Content-Encoding.
 *
 * Throws synchronously when the Content-Encoding is not supported; stream
 * failures (limit exceeded, corrupt gzip) are emitted as an error on the
 * returned stream so the regular payload parsing error path handles them.
 */
function getDecompressedPayloadStream (request, config) {
  const contentEncoding = request.headers['content-encoding']

  if (contentEncoding === undefined) {
    return request.raw
  }

  const encoding = contentEncoding.trim().toLowerCase()
  if (encoding === '' || encoding === 'identity') {
    return request.raw
  }

  if (encoding !== 'gzip') {
    throw new FST_ERR_CTP_INVALID_CONTENT_ENCODING(contentEncoding)
  }

  return buildGunzipPayloadStream(request, config)
}

function buildGunzipPayloadStream (request, config) {
  const raw = request.raw
  const gunzip = zlib.createGunzip()
  let compressedLength = 0
  let decompressedLength = 0

  const compressedCounter = new Transform({
    transform (chunk, encoding, callback) {
      compressedLength += chunk.length
      // Let the payload parser compare the received compressed bytes with
      // the Content-Length header, as it does for plain bodies.
      terminal.receivedEncodedLength = compressedLength
      if (compressedLength > config.compressedLimit) {
        callback(new FST_ERR_CTP_BODY_TOO_LARGE())
        return
      }
      callback(null, chunk)
    }
  })

  const terminal = new Transform({
    transform (chunk, encoding, callback) {
      decompressedLength += chunk.length
      if (decompressedLength > config.decompressedLimit) {
        callback(new FST_ERR_CTP_BODY_TOO_LARGE())
        return
      }
      callback(null, chunk)
    }
  })
  terminal.receivedEncodedLength = 0

  let settled = false
  let storedError = null
  let rawEnded = false

  function cleanup () {
    raw.removeListener('close', onRawClose)
    raw.removeListener('end', onRawEnd)
    compressedCounter.removeListener('error', onChainError)
    gunzip.removeListener('error', onChainError)
    terminal.removeListener('error', onTerminalError)
  }

  function onRawEnd () {
    rawEnded = true
  }

  function destroyChain () {
    raw.unpipe(compressedCounter)
    if (!compressedCounter.destroyed) compressedCounter.destroy()
    if (!gunzip.destroyed) gunzip.destroy()
  }

  function onChainError (err) {
    if (settled) return
    settled = true
    cleanup()
    destroyChain()
    forwardError(normalizeDecompressionError(err))
  }

  function onTerminalError () {
    // The terminal stream itself failed (decompressed limit reached). Its
    // consumer receives the error directly; tear down the rest of the chain.
    if (settled) return
    settled = true
    cleanup()
    destroyChain()
  }

  function onRawClose () {
    // The client went away: end the chain, zlib included, without
    // producing another reply.
    // A close after a normal end of the raw stream is not an abort: the
    // chain is still draining and finishes on its own.
    if (settled || rawEnded) return
    settled = true
    cleanup()
    destroyChain()
    if (!terminal.destroyed) terminal.destroy()
  }

  function forwardError (err) {
    if (terminal.destroyed) return
    if (terminal.listenerCount('error') > 0) {
      terminal.destroy(err)
      return
    }
    // No consumer is attached yet: hold the error until one subscribes.
    storedError = err
  }

  terminal.on('newListener', (event) => {
    if (event === 'error' && storedError !== null) {
      const err = storedError
      storedError = null
      process.nextTick(() => { terminal.destroy(err) })
    }
  })

  raw.once('close', onRawClose)
  raw.once('end', onRawEnd)
  compressedCounter.once('error', onChainError)
  gunzip.once('error', onChainError)
  terminal.once('error', onTerminalError)
  terminal.once('close', cleanup)

  raw.pipe(compressedCounter).pipe(gunzip).pipe(terminal)

  return terminal
}

function normalizeDecompressionError (err) {
  if (typeof err.statusCode === 'number' && err.statusCode >= 400) {
    return err
  }
  return new FST_ERR_CTP_INVALID_GZIP_BODY()
}

module.exports = {
  normalizeDecompressionOption,
  resolveRouteDecompression,
  getDecompressedPayloadStream
}
