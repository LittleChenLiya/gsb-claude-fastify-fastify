'use strict'

const {
  FST_ERR_ASYNC_VALIDATORS_INVALID,
  FST_ERR_ASYNC_VALIDATION,
  FST_ERR_ASYNC_VALIDATOR_PATH,
  FST_ERR_ASYNC_VALIDATOR_RESULT
} = require('./errors')

// Field paths declared by async validators must be rooted at one of the
// validated request parts. Anything else (for example `server` or `reply`)
// would let a validator observe or report on objects outside the validated
// request payload.
const kAllowedRoots = new Set(['body', 'query', 'params', 'headers'])

// Path segments that must never be traversed while reading a value from the
// request, to avoid walking into prototype-chain properties.
const kForbiddenSegments = new Set(['__proto__', 'prototype', 'constructor'])

const kMaxDiagnosticPathLength = 128

function parseValidatorPath (path) {
  if (typeof path !== 'string' || path.length === 0) {
    return null
  }
  const segments = path.split('.')
  if (segments.some((segment) => segment.length === 0)) {
    return null
  }
  if (!kAllowedRoots.has(segments[0])) {
    return null
  }
  if (segments.some((segment) => kForbiddenSegments.has(segment))) {
    return null
  }
  return segments
}

// Validates and normalizes the asyncValidators route option. Throws
// synchronously at route registration time when a declaration is invalid, so
// a misconfigured route fails at boot instead of at request time.
function normalizeAsyncValidators (validators, method, url) {
  if (validators === undefined) {
    return null
  }

  const where = method + ' ' + url

  if (!Array.isArray(validators)) {
    throw new FST_ERR_ASYNC_VALIDATORS_INVALID(where, 'the option must be an array')
  }

  return validators.map((validator, index) => {
    const label = where + ' (validator #' + index + ')'
    if (validator === null || typeof validator !== 'object' || Array.isArray(validator)) {
      throw new FST_ERR_ASYNC_VALIDATORS_INVALID(label, 'each entry must be an object with a path and a validate function')
    }
    if (typeof validator.validate !== 'function') {
      throw new FST_ERR_ASYNC_VALIDATORS_INVALID(label, 'the validate property must be a function')
    }
    const segments = parseValidatorPath(validator.path)
    if (segments === null) {
      throw new FST_ERR_ASYNC_VALIDATORS_INVALID(label, 'the path must be a string rooted at body, query, params or headers')
    }
    return {
      path: validator.path,
      segments,
      validate: validator.validate
    }
  })
}

function extractValue (request, segments) {
  let value = request
  for (const segment of segments) {
    if (value === null || typeof value !== 'object') {
      return undefined
    }
    value = value[segment]
  }
  return value
}

function sanitizeDiagnosticPath (path) {
  const text = String(path)
  return text.length > kMaxDiagnosticPathLength
    ? text.slice(0, kMaxDiagnosticPathLength)
    : text
}

// Normalizes the value returned (or resolved) by a single validator into a
// list of sanitized business errors and a list of contract diagnostics.
//
// A validator reports a failure by returning an object (or an array of
// objects) shaped like { message, code?, path? }. Only message and code are
// copied into the reported error: any other property - for example a value
// echoing the original request payload - is dropped so that reported errors
// can never carry original request values. A returned path other than the
// declared one is a contract violation and is diagnosed separately from
// business failures.
function normalizeReport (validator, report) {
  const errors = []
  const diagnostics = []

  if (report === undefined || report === null || report === true || report === false) {
    return { errors, diagnostics }
  }

  const entries = Array.isArray(report) ? report : [report]

  for (const entry of entries) {
    if (entry === undefined || entry === null) {
      continue
    }
    if (typeof entry !== 'object' || typeof entry.message !== 'string') {
      diagnostics.push({
        code: 'FST_ERR_ASYNC_VALIDATOR_RESULT',
        path: validator.path,
        message: 'async validator for ' + validator.path + ' must resolve to null, an error object { message } or an array of them'
      })
      continue
    }
    if (entry.path !== undefined && entry.path !== validator.path) {
      diagnostics.push({
        code: 'FST_ERR_ASYNC_VALIDATOR_PATH',
        path: validator.path,
        message: 'async validator for ' + validator.path + ' returned an error for undeclared path ' + sanitizeDiagnosticPath(entry.path)
      })
      continue
    }
    const sanitized = { path: validator.path, message: entry.message }
    if (typeof entry.code === 'string') {
      sanitized.code = entry.code
    }
    errors.push(sanitized)
  }

  return { errors, diagnostics }
}

function runOneValidator (validator, request) {
  const value = extractValue(request, validator.segments)
  let report
  try {
    report = validator.validate(value, request)
  } catch (err) {
    return Promise.reject(err)
  }
  return Promise.resolve(report).then((resolved) => normalizeReport(validator, resolved))
}

// Runs every registered async validator in parallel and waits for all of
// them to settle (a barrier) before reporting. The merged report keeps the
// registration order regardless of the order in which the validators
// resolved. If the request is cancelled while the validators are running,
// late results - failures and successes alike - are dropped: no error is
// published and the route handler is never entered.
//
// done(err) is invoked exactly once, unless the request was cancelled:
//   - err is a FST_ERR_ASYNC_VALIDATION (400) carrying the merged,
//     registration-ordered validation list when business failures occurred
//   - err is a FST_ERR_ASYNC_VALIDATOR_PATH / FST_ERR_ASYNC_VALIDATOR_RESULT
//     (500) when a validator broke the result contract; these are diagnosed
//     separately and never merged into the 400 business result
//   - err is null when every validator passed
function runAsyncValidators (context, request, reply, done) {
  const validators = context.asyncValidators
  const rawRequest = request.raw
  const rawReply = reply.raw

  let cancelled = false

  const onRequestClose = () => {
    if (rawRequest.aborted === true || rawRequest.complete === false) {
      cancelled = true
    }
  }
  const onResponseClose = () => {
    if (rawReply.writableEnded !== true) {
      cancelled = true
    }
  }

  rawRequest.once('close', onRequestClose)
  rawReply.once('close', onResponseClose)

  const cleanup = () => {
    rawRequest.removeListener('close', onRequestClose)
    rawReply.removeListener('close', onResponseClose)
  }

  Promise.all(validators.map((validator) => runOneValidator(validator, request))).then(
    (reports) => {
      cleanup()
      // The request was cancelled (or already answered) while the validators
      // were in flight: stop here and publish nothing.
      if (cancelled || reply.sent) {
        return
      }

      const failures = []
      const diagnostics = []
      // reports follows the registration order, so the merged lists are
      // stably ordered no matter which validator settled first.
      for (const report of reports) {
        for (const error of report.errors) {
          failures.push(error)
        }
        for (const diagnostic of report.diagnostics) {
          diagnostics.push(diagnostic)
        }
      }

      if (diagnostics.length !== 0) {
        const first = diagnostics[0]
        const error = first.code === 'FST_ERR_ASYNC_VALIDATOR_PATH'
          ? new FST_ERR_ASYNC_VALIDATOR_PATH(first.path, first.message)
          : new FST_ERR_ASYNC_VALIDATOR_RESULT(first.path, first.message)
        error.diagnostics = diagnostics
        done(error)
        return
      }

      if (failures.length !== 0) {
        const config = context.config || {}
        const error = new FST_ERR_ASYNC_VALIDATION(
          'Async validation failed for ' + config.method + ' ' + config.url + ': ' + failures.map((failure) => failure.path).join(', ')
        )
        error.validation = failures
        error.validationContext = 'asyncValidators'
        done(error)
        return
      }

      done(null)
    },
    (err) => {
      cleanup()
      if (cancelled || reply.sent) {
        return
      }
      done(err)
    }
  )
}

module.exports = {
  normalizeAsyncValidators,
  runAsyncValidators
}
