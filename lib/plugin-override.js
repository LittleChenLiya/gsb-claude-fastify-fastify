'use strict'

const {
  kAvvioBoot,
  kChildren,
  kRoutePrefix,
  kLogLevel,
  kLogSerializers,
  kHooks,
  kSchemaController,
  kContentTypeParser,
  kReply,
  kRequest,
  kFourOhFour,
  kPluginNameChain,
  kErrorHandlerAlreadySet,
  kSealedConfig,
  kOptions
} = require('./symbols.js')

const Reply = require('./reply')
const Request = require('./request')
const SchemaController = require('./schema-controller')
const ContentTypeParser = require('./content-type-parser.js')
const { buildHooks } = require('./hooks')
const pluginUtils = require('./plugin-utils.js')
const { createSealedConfig } = require('./sealed-config.js')

// Function that runs the encapsulation magic.
// Everything that need to be encapsulated must be handled in this function.
module.exports = function override (old, fn, opts) {
  const shouldSkipOverride = pluginUtils.registerPlugin.call(old, fn)

  const fnName = pluginUtils.getPluginName(fn) || pluginUtils.getFuncPreview(fn)
  if (shouldSkipOverride) {
    // after every plugin registration we will enter a new name
    old[kPluginNameChain].push(fnName)

    // Skip-override plugins (e.g. fastify-plugin) run in the parent scope
    // without creating a new instance. Produce the sealed snapshot here and
    // attach it to the wrapped function so the plugin still receives it.
    if (old[kOptions] && old[kOptions].sealPluginConfig === true) {
      fn[kSealedConfig] = createSealedConfig(opts, old[kSealedConfig] || null, fnName)
    }
    return old
  }

  const instance = Object.create(old)
  old[kChildren].push(instance)
  instance.ready = old[kAvvioBoot].bind(instance)
  instance[kChildren] = []

  instance[kReply] = Reply.buildReply(instance[kReply])
  instance[kRequest] = Request.buildRequest(instance[kRequest])

  instance[kContentTypeParser] = ContentTypeParser.helpers.buildContentTypeParser(instance[kContentTypeParser])
  instance[kHooks] = buildHooks(instance[kHooks])
  instance[kRoutePrefix] = buildRoutePrefix(instance[kRoutePrefix], opts.prefix)
  instance[kLogLevel] = opts.logLevel || instance[kLogLevel]
  instance[kSchemaController] = SchemaController.buildSchemaController(old[kSchemaController])
  instance.getSchema = instance[kSchemaController].getSchema.bind(instance[kSchemaController])
  instance.getSchemas = instance[kSchemaController].getSchemas.bind(instance[kSchemaController])

  // Track the registered and loaded plugins since the root instance.
  // It does not track the current encapsulated plugin.
  instance[pluginUtils.kRegisteredPlugins] = Object.create(instance[pluginUtils.kRegisteredPlugins])

  // Track the plugin chain since the root instance.
  // When an non-encapsulated plugin is added, the chain will be updated.
  instance[kPluginNameChain] = [fnName]
  instance[kErrorHandlerAlreadySet] = false

  // When explicit read-only config sealing is enabled, produce an independent
  // frozen snapshot of the plugin options. The child scope inherits the
  // parent's sealed config as its base and only overrides the keys the plugin
  // itself defines, so child overrides never mutate the parent.
  if (old[kOptions] && old[kOptions].sealPluginConfig === true) {
    instance[kSealedConfig] = createSealedConfig(opts, old[kSealedConfig], fnName)
  }

  if (instance[kLogSerializers] || opts.logSerializers) {
    instance[kLogSerializers] = Object.assign(Object.create(instance[kLogSerializers]), opts.logSerializers)
  }

  if (opts.prefix) {
    instance[kFourOhFour].arrange404(instance)
  }

  for (const hook of instance[kHooks].onRegister) hook.call(old, instance, opts)

  return instance
}

function buildRoutePrefix (instancePrefix, pluginPrefix) {
  if (!pluginPrefix) {
    return instancePrefix
  }

  // Ensure that there is a '/' between the prefixes
  if (instancePrefix.endsWith('/') && pluginPrefix[0] === '/') {
    // Remove the extra '/' to avoid: '/first//second'
    pluginPrefix = pluginPrefix.slice(1)
  } else if (pluginPrefix[0] !== '/' && !instancePrefix.endsWith('/')) {
    // Add the missing '/' to avoid: '/firstsecond'
    pluginPrefix = '/' + pluginPrefix
  }

  return instancePrefix + pluginPrefix
}
