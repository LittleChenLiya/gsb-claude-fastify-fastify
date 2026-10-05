'use strict'

const {
  kFourOhFourContext,
  kReplySerializerDefault,
  kSchemaErrorFormatter,
  kErrorHandler,
  kChildLoggerFactory,
  kReply,
  kRequest,
  kBodyLimit,
  kLogLevel,
  kContentTypeParser,
  kRouteByFastify,
  kRequestCacheValidateFns,
  kReplyCacheSerializeFns,
  kHandlerTimeout,
  kBusinessValidators,
  kValidationFields
} = require('./symbols.js')

// Object that holds the context of every request
// Every route holds an instance of this object.
function Context ({
  schema,
  handler,
  config,
  childLoggerFactory,
  errorHandler,
  bodyLimit,
  logLevel,
  logSerializers,
  attachValidation,
  validatorCompiler,
  serializerCompiler,
  replySerializer,
  schemaErrorFormatter,
  exposeHeadRoute,
  prefixTrailingSlash,
  server,
  isFastify,
  handlerTimeout,
  businessValidators,
  validationFields
}) {
  this.schema = schema
  this.handler = handler
  this.Reply = server[kReply]
  this.Request = server[kRequest]
  this.contentTypeParser = server[kContentTypeParser]
  this.onRequest = null
  this.onSend = null
  this.onError = null
  this.onTimeout = null
  this.preHandler = null
  this.onResponse = null
  this.preSerialization = null
  this.onRequestAbort = null
  this.config = config
  this.errorHandler = errorHandler || server[kErrorHandler]
  this.childLoggerFactory = childLoggerFactory || server[kChildLoggerFactory]
  this._middie = null
  this._parserOptions = {
    limit: bodyLimit || server[kBodyLimit]
  }
  this.exposeHeadRoute = exposeHeadRoute
  this.prefixTrailingSlash = prefixTrailingSlash
  this.logLevel = logLevel || server[kLogLevel]
  this.logSerializers = logSerializers
  this[kFourOhFourContext] = null
  this.attachValidation = attachValidation
  this[kReplySerializerDefault] = replySerializer
  this.schemaErrorFormatter =
    schemaErrorFormatter ||
    server[kSchemaErrorFormatter] ||
    defaultSchemaErrorFormatter
  this[kRouteByFastify] = isFastify

  this[kRequestCacheValidateFns] = null
  this[kReplyCacheSerializeFns] = null
  this.validatorCompiler = validatorCompiler || null
  this.serializerCompiler = serializerCompiler || null

  this.handlerTimeout = handlerTimeout || server[kHandlerTimeout] || 0
  this.server = server

  // Business validation layer (explicit, async, opt-in).
  // `businessValidators` is an array of async validator functions;
  // `validationFields` is the declared whitelist of field paths they may
  // report. When no validators are registered the layer is a no-op and the
  // route behaves exactly as it did before.
  this[kBusinessValidators] = Array.isArray(businessValidators) ? businessValidators : null
  this[kValidationFields] = Array.isArray(validationFields) ? validationFields : null
}

function defaultSchemaErrorFormatter (errors, dataVar) {
  let text = ''
  const separator = ', '

  for (let i = 0; i !== errors.length; ++i) {
    const e = errors[i]
    text += dataVar + (e.instancePath || '') + ' ' + e.message + separator
  }
  return new Error(text.slice(0, -separator.length))
}

module.exports = Context
