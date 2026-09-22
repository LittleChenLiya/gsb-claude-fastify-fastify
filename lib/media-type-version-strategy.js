'use strict'

const assert = require('node:assert')
const { kMediaTypeVersionState } = require('./symbols')

const kDerived = Symbol('fastify.mediaTypeVersionDerived')

const MEDIA_TYPE_PATTERN = /^[^\s/]+\/[^\s/]+$/
const Q_VALUE_PATTERN = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/

// Splits a header value on `separator` while honoring quoted strings
// (RFC 9110, Section 5.6.4), so separators hidden inside quoted
// parameter values do not split.
function splitOutsideQuotes (value, separator) {
  const parts = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (inQuotes) {
      if (char === '\\' && i + 1 < value.length) {
        current += char + value[i + 1]
        i++
        continue
      }
      if (char === '"') {
        inQuotes = false
      }
      current += char
    } else if (char === '"') {
      inQuotes = true
      current += char
    } else if (char === separator) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts
}

function unquote (value) {
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    return value.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  return value
}

function mediaTypeSpecificity (type, subtype) {
  if (type === '*') return 0
  if (subtype === '*') return 1
  return 2
}

class MediaTypeVersionParseError extends Error {
  constructor (message) {
    super(message)
    this.name = 'MediaTypeVersionParseError'
  }
}

// Parses an Accept header value into a list of media range entries.
// Multiple Accept header fields are already combined by Node.js into a
// single comma-separated value, which this parser understands.
// Throws a MediaTypeVersionParseError on invalid q values or duplicated
// version parameters.
function parseAcceptHeader (header) {
  const entries = []
  const items = splitOutsideQuotes(header, ',')
  for (const item of items) {
    if (item.trim() === '') continue

    const segments = splitOutsideQuotes(item, ';')
    const mediaType = segments[0].trim().toLowerCase()
    if (!MEDIA_TYPE_PATTERN.test(mediaType)) continue

    const [type, subtype] = mediaType.split('/')
    let version
    let q = 1

    for (let i = 1; i < segments.length; i++) {
      const segment = segments[i]
      const eq = segment.indexOf('=')
      if (eq === -1) continue
      const name = segment.slice(0, eq).trim().toLowerCase()
      const rawValue = segment.slice(eq + 1).trim()
      if (name === 'q') {
        const unquoted = unquote(rawValue)
        if (!Q_VALUE_PATTERN.test(unquoted)) {
          throw new MediaTypeVersionParseError("'q=" + rawValue + "' is not a valid quality value")
        }
        q = Number(unquoted)
      } else if (name === 'version') {
        if (version !== undefined) {
          throw new MediaTypeVersionParseError("duplicated 'version' parameter in a single media type")
        }
        version = unquote(rawValue)
      }
      // any other parameter (quoted or not) is accepted and ignored
    }

    entries.push({
      type,
      subtype,
      version,
      q,
      specificity: mediaTypeSpecificity(type, subtype),
      index: entries.length
    })
  }
  return entries
}

// Picks the best matching Accept entry for a registered route.
// The most specific media range wins; entries carrying an explicit
// version parameter are more specific than entries without one;
// earlier entries win ties.
function bestEntryFor (route, entries) {
  let best = null
  for (const entry of entries) {
    if (entry.type === '*') {
      if (entry.subtype !== '*') continue
    } else if (entry.type !== route.type || (entry.subtype !== '*' && entry.subtype !== route.subtype)) {
      continue
    }
    if (entry.version !== undefined && entry.version !== route.version) {
      continue
    }
    if (best === null ||
      entry.specificity > best.specificity ||
      (entry.specificity === best.specificity && entry.version !== undefined && best.version === undefined)) {
      best = entry
    }
  }
  return best
}

class MediaTypeVersionStore {
  constructor (config) {
    this.config = config
    this.routes = []
    this.registered = new Map()
  }

  set (value, bitmap) {
    const [type, subtype] = value.mediaType.toLowerCase().split('/')
    this.routes.push({
      version: value.version,
      mediaType: value.mediaType.toLowerCase(),
      type,
      subtype,
      bitmap,
      order: this.routes.length
    })
    this.registered.set(value, bitmap)
    return this
  }

  get (derived) {
    if (derived !== null && typeof derived === 'object' && derived[kDerived] === true) {
      return this.negotiate(derived)
    }
    // find-my-way queries the store with the registered constraint
    // values while compiling the matcher
    return this.registered.get(derived)
  }

  negotiate (derived) {
    const candidates = []
    if (derived.entries === null) {
      // No Accept header: only the explicitly configured default
      // version is acceptable.
      for (const route of this.routes) {
        if (route.version === this.config.defaultVersion) {
          candidates.push({ route, q: 1, specificity: -1, entryIndex: -1 })
        }
      }
    } else {
      for (const route of this.routes) {
        const entry = bestEntryFor(route, derived.entries)
        // q=0 means "not acceptable" and excludes the route
        if (entry !== null && entry.q > 0) {
          candidates.push({ route, q: entry.q, specificity: entry.specificity, entryIndex: entry.index })
        }
      }
    }

    if (candidates.length === 0) {
      derived.outcome = 'not-acceptable'
      return 0
    }

    const priority = this.config.versionPriority
    candidates.sort((a, b) => {
      if (b.q !== a.q) return b.q - a.q
      if (b.specificity !== a.specificity) return b.specificity - a.specificity
      const aPriority = priority.indexOf(a.route.version)
      const bPriority = priority.indexOf(b.route.version)
      const aRank = aPriority === -1 ? priority.length : aPriority
      const bRank = bPriority === -1 ? priority.length : bPriority
      if (aRank !== bRank) return aRank - bRank
      // deterministic final tie-breakers that do not rely on
      // object key traversal order
      if (a.entryIndex !== b.entryIndex) return a.entryIndex - b.entryIndex
      return a.route.order - b.route.order
    })

    return candidates[0].route.bitmap
  }
}

/**
 * Builds an optional find-my-way constraint strategy that negotiates the
 * API version from the media type parameters of the Accept header
 * (e.g. 'application/vnd.demo+json;version=2;q=0.8') instead of the
 * Accept-Version header.
 *
 * @param {object} [options]
 * @param {string} [options.defaultVersion] version used when the request
 *   has no Accept header
 * @param {string[]} [options.versionPriority] versions ordered from the
 *   most to the least preferred, used to break ties
 */
function buildMediaTypeVersionStrategy (options) {
  options = options || {}
  assert(
    options.defaultVersion === undefined || typeof options.defaultVersion === 'string',
    'mediaTypeVersioning.defaultVersion must be a string'
  )
  assert(
    options.versionPriority === undefined ||
      (Array.isArray(options.versionPriority) && options.versionPriority.every(v => typeof v === 'string')),
    'mediaTypeVersioning.versionPriority must be an array of strings'
  )

  const config = {
    defaultVersion: options.defaultVersion,
    versionPriority: options.versionPriority || []
  }

  return {
    name: 'apiVersion',
    // Unconstrained routes must stay reachable no matter what was
    // derived from the Accept header.
    mustMatchWhenDerived: false,
    storage () {
      return new MediaTypeVersionStore(config)
    },
    validate (value) {
      assert(value !== null && typeof value === 'object', 'apiVersion constraint must be an object')
      assert(typeof value.version === 'string', 'apiVersion constraint requires a string version')
      assert(typeof value.mediaType === 'string' && MEDIA_TYPE_PATTERN.test(value.mediaType),
        "apiVersion constraint requires a mediaType in the form 'type/subtype'")
    },
    deriveConstraint (req) {
      const accept = req.headers.accept
      if (accept === undefined || accept === '') {
        const derived = { [kDerived]: true, entries: null, outcome: 'ok' }
        req[kMediaTypeVersionState] = derived
        return derived
      }
      try {
        const derived = { [kDerived]: true, entries: parseAcceptHeader(accept), outcome: 'ok' }
        req[kMediaTypeVersionState] = derived
        return derived
      } catch (error) {
        // Never throw from constraint derivation: mark the request and
        // let the routing layer answer with a 400.
        req[kMediaTypeVersionState] = { outcome: 'error', message: error.message }
        return undefined
      }
    }
  }
}

module.exports = { buildMediaTypeVersionStrategy, parseAcceptHeader, MediaTypeVersionParseError }
