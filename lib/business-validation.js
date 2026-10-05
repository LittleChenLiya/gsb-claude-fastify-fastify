'use strict'

const {
  kBusinessValidators,
  kValidationFields
} = require('./symbols')
const {
  FST_ERR_BUSINESS_VALIDATION
} = require('./errors')

// The business validation layer is an explicit, opt-in, asynchronous
// validation step that runs *after* the schema (Ajv) validation has passed.
//
// Unlike schema validation, which is declarative and compiled ahead of time,
// business validators are plain async functions registered on the route. They
// run in parallel and their reports are merged into an independent result that
// never touches Ajv's original errors.
//
// Key properties:
//   - validators run in parallel; reports are collected in registration order
//     regardless of completion order (stable ordering).
//   - only field paths declared via `validationFields` may be reported; a
//     validator returning an undeclared path is diagnosed separately and the
//     path is dropped from the merged errors.
//   - errors are sanitized to `{ field, message }` only, so a validator can
//     never leak the original request value (no `value`, `data`, ...).
//   - if the request is cancelled while validators are still running, late
//     errors (and late successes) are dropped: no error is published and the
//     handler is never entered.
//   - the layer is a no-op for routes that did not register validators.

function normalizeResult (result) {
  if (!result) return []
  if (Array.isArray(result)) {
    // Keep only object entries; ignore malformed elements.
    return result.filter(item => item !== null && typeof item === 'object')
  }
  if (typeof result !== 'object') return []
  return [result]
}

// Sanitize a raw error into the public shape. Only `field` and `message` are
// kept so that no original request value can be carried into the response.
function sanitizeError (raw) {
  const field = raw.field !== undefined ? raw.field : raw.path
  return { field, message: raw.message }
}

function validateBusiness (context, request) {
  const validators = context[kBusinessValidators]
  if (validators === null || validators.length === 0) {
    return false
  }

  const allowedFields = context[kValidationFields]

  // Run all validators in parallel. Each result is tagged with its
  // registration index so the final report can be sorted back into
  // registration order no matter in which order the promises settle.
  const promises = validators.map((validator, index) => {
    return Promise.resolve()
      .then(() => validator(request))
      .then(
        (result) => ({ index, result }),
        (error) => ({ index, error })
      )
  })

  return Promise.all(promises).then((settled) => {
    settled.sort((a, b) => a.index - b.index)

    const errors = []
    const diagnostics = []

    for (const entry of settled) {
      if (entry.error) {
        // A validator that throws is an internal failure, not a validation
        // result: propagate it so the error handler can report it.
        throw entry.error
      }

      const rawErrors = normalizeResult(entry.result)
      for (const raw of rawErrors) {
        const field = raw.field !== undefined ? raw.field : raw.path
        if (allowedFields !== null && !allowedFields.includes(field)) {
          // The validator reported a field path that was not declared. This
          // must not be merged into the validation errors; it is diagnosed
          // separately so the misconfiguration is visible.
          diagnostics.push({ field, reason: 'field path is not declared' })
          continue
        }
        errors.push(sanitizeError(raw))
      }
    }

    if (errors.length === 0 && diagnostics.length === 0) {
      return false
    }

    return wrapBusinessValidationError(errors, diagnostics)
  })
}

function wrapBusinessValidationError (errors, diagnostics) {
  const error = new FST_ERR_BUSINESS_VALIDATION()
  error.statusCode = 400
  error.code = 'FST_ERR_BUSINESS_VALIDATION'
  error.validation = errors
  error.diagnostics = diagnostics
  return error
}

module.exports = {
  validateBusiness,
  // exported for testing purposes only
  internals: {
    normalizeResult,
    sanitizeError
  }
}
