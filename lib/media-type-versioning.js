'use strict'

const { kMediaTypeNegotiation } = require('./symbols')
const {
  FST_ERR_ACCEPT_INVALID_Q,
  FST_ERR_ACCEPT_DUPLICATE_VERSION,
  FST_ERR_VERSIONING_INVALID_OPTIONS,
  FST_ERR_VERSIONING_INVALID_CONSTRAINT
} = require('./errors')

// Brands the per-request negotiation context so the storage can tell it apart
// from the registered constraint values find-my-way reads back while building
// the constraint store.
const kNegotiationContext = Symbol('fastify.mediaTypeNegotiationContext')

const Q_VALUE_REGEX = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/
const MEDIA_TYPE_REGEX = /^[!#$%&'*+.^_`|~0-9a-z]+\/[#!$%&'*+.^_`|~0-9a-z-]+$/i

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
    let result = ''
    const inner = value.slice(1, -1)
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '\\' && i + 1 < inner.length) {
        result += inner[i + 1]
        i++
      } else {
        result += inner[i]
      }
    }
    return result
  }
  return value
}

function mediaTypeSpecificity (mediaType) {
  if (mediaType === '*/*') return 0
  if (mediaType.endsWith('/*')) return 1
  return 2
}

// Returns the specificity of the match (2 exact, 1 type wildcard, 0 full
// wildcard) or -1 when the accept media type does not match the candidate.
function matchMediaType (acceptMediaType, candidateMediaType) {
  if (candidateMediaType === null) {
    return mediaTypeSpecificity(acceptMediaType)
  }
  if (acceptMediaType === candidateMediaType) return 2
  if (acceptMediaType === '*/*') return 0
  if (acceptMediaType.endsWith('/*')) {
    const prefix = acceptMediaType.slice(0, -1)
    if (candidateMediaType.startsWith(prefix)) return 1
  }
  return -1
}

function parseAcceptEntry (part) {
  const segments = splitOutsideQuotes(part, ';')
  const mediaType = segments[0].trim().toLowerCase()
  let version = null
  let q = 1
  let qSeen = false

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i].trim()
    if (segment === '') continue
    const eqIndex = segment.indexOf('=')
    const name = (eqIndex === -1 ? segment : segment.slice(0, eqIndex)).trim().toLowerCase()
    const value = eqIndex === -1 ? '' : unquote(segment.slice(eqIndex + 1).trim())

    if (name === 'q') {
      if (qSeen || !Q_VALUE_REGEX.test(value)) {
        return { error: new FST_ERR_ACCEPT_INVALID_Q(value) }
      }
      qSeen = true
      q = Number(value)
    } else if (name === 'version') {
      if (version !== null) {
        return { error: new FST_ERR_ACCEPT_DUPLICATE_VERSION() }
      }
      version = value
    }
  }

  return { entry: { mediaType, version, q } }
}

function parseAcceptHeader (header) {
  const entries = []
  for (const part of splitOutsideQuotes(header, ',')) {
    if (part.trim() === '') continue
    const parsed = parseAcceptEntry(part)
    if (parsed.error !== undefined) {
      return { error: parsed.error }
    }
    entries.push(parsed.entry)
  }
  return { entries }
}

function scoreCandidate (candidate, entries) {
  let best = null
  for (const entry of entries) {
    if (entry.q <= 0) continue
    if (entry.version !== null && entry.version !== candidate.version) continue
    const specificity = matchMediaType(entry.mediaType, candidate.mediaType)
    if (specificity === -1) continue
    if (best === null || entry.q > best.q || (entry.q === best.q && specificity > best.specificity)) {
      best = { q: entry.q, specificity }
    }
  }
  return best
}

function compareNullableStrings (a, b) {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return a < b ? -1 : 1
}

function priorityIndex (versionPriority, version) {
  const index = versionPriority.indexOf(version)
  return index === -1 ? versionPriority.length : index
}

// Picks exactly one candidate using a total, deterministic order:
// highest q, then highest media type specificity, then the configured
// version priority, then version and media type string order as final
// tiebreakers so the result never depends on registration order.
function selectCandidate (candidates, context) {
  if (!context.hasAccept) {
    if (context.defaultVersion === undefined) return null
    const defaults = candidates.filter(candidate => candidate.version === context.defaultVersion)
    if (defaults.length === 0) return null
    defaults.sort((a, b) =>
      compareNullableStrings(a.mediaType, b.mediaType) ||
      compareNullableStrings(a.version, b.version)
    )
    return defaults[0]
  }

  const acceptable = []
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, context.entries)
    if (score !== null) {
      acceptable.push({ candidate, score })
    }
  }
  if (acceptable.length === 0) return null

  const versionPriority = context.versionPriority
  acceptable.sort((a, b) => {
    if (b.score.q !== a.score.q) return b.score.q - a.score.q
    if (b.score.specificity !== a.score.specificity) return b.score.specificity - a.score.specificity
    const priorityDiff = priorityIndex(versionPriority, a.candidate.version) -
      priorityIndex(versionPriority, b.candidate.version)
    if (priorityDiff !== 0) return priorityDiff
    const byVersion = compareNullableStrings(b.candidate.version, a.candidate.version)
    if (byVersion !== 0) return byVersion
    return compareNullableStrings(a.candidate.mediaType, b.candidate.mediaType)
  })
  return acceptable[0].candidate
}

function candidateKey (value) {
  return (value.mediaType === null ? '' : value.mediaType) + '\n' + value.version
}

function createMediaTypeVersioningStorage () {
  const candidates = new Map()
  return {
    set (value, bitmask) {
      const key = candidateKey(value)
      const existing = candidates.get(key)
      if (existing === undefined) {
        candidates.set(key, { version: value.version, mediaType: value.mediaType, bitmask })
      } else {
        existing.bitmask |= bitmask
      }
    },
    get (value) {
      if (value !== null && typeof value === 'object' && value[kNegotiationContext] === true) {
        value.applied = true
        if (value.error !== null) return 0
        const winner = selectCandidate([...candidates.values()], value)
        if (winner === null) return 0
        value.matched = true
        return winner.bitmask
      }
      // find-my-way reads registered constraint values back while building
      // the constraint store, answer with the stored bitmask
      const existing = candidates.get(candidateKey(value))
      return existing === undefined ? 0 : existing.bitmask
    }
  }
}

function createNegotiationContext (acceptHeader, options) {
  const context = {
    [kNegotiationContext]: true,
    applied: false,
    matched: false,
    error: null,
    entries: null,
    hasAccept: acceptHeader !== undefined,
    defaultVersion: options.defaultVersion,
    versionPriority: options.versionPriority
  }
  if (context.hasAccept) {
    const parsed = parseAcceptHeader(acceptHeader)
    if (parsed.error !== undefined) {
      context.error = parsed.error
    } else {
      context.entries = parsed.entries
    }
  }
  return context
}

function validateStrategyOptions (options) {
  if (options === undefined || options === null) {
    return {}
  }
  if (typeof options !== 'object') {
    throw new FST_ERR_VERSIONING_INVALID_OPTIONS('must be an object')
  }
  if (options.defaultVersion !== undefined &&
    (typeof options.defaultVersion !== 'string' || options.defaultVersion.length === 0)) {
    throw new FST_ERR_VERSIONING_INVALID_OPTIONS('"defaultVersion" must be a non-empty string')
  }
  if (options.versionPriority !== undefined &&
    (!Array.isArray(options.versionPriority) || options.versionPriority.some(version => typeof version !== 'string'))) {
    throw new FST_ERR_VERSIONING_INVALID_OPTIONS('"versionPriority" must be an array of version strings')
  }
  return options
}

function buildMediaTypeVersionStrategy (strategyOptions) {
  const options = validateStrategyOptions(strategyOptions)
  const defaultVersion = options.defaultVersion
  const versionPriority = options.versionPriority === undefined ? [] : [...options.versionPriority]

  return {
    name: 'apiVersion',
    mustMatchWhenDerived: false,
    storage: createMediaTypeVersioningStorage,
    validate (value) {
      if (value === null || typeof value !== 'object' ||
        typeof value.version !== 'string' || value.version.length === 0 ||
        (value.mediaType !== null && typeof value.mediaType !== 'string')) {
        throw new FST_ERR_VERSIONING_INVALID_CONSTRAINT('"apiVersion" must hold a version string and an optional media type')
      }
    },
    deriveConstraint (req) {
      let context = req[kMediaTypeNegotiation]
      if (context === undefined) {
        context = createNegotiationContext(req.headers.accept, { defaultVersion, versionPriority })
        req[kMediaTypeNegotiation] = context
      }
      return context
    }
  }
}

// Merges the user facing "apiVersion" and "mediaType" constraint keys into a
// single internal "apiVersion" constraint object so that one find-my-way
// strategy can negotiate over both values at once.
function normalizeVersioningConstraints (constraints) {
  const hasApiVersion = Object.hasOwn(constraints, 'apiVersion')
  const hasMediaType = Object.hasOwn(constraints, 'mediaType')
  if (!hasApiVersion && !hasMediaType) {
    return constraints
  }
  if (!hasApiVersion) {
    throw new FST_ERR_VERSIONING_INVALID_CONSTRAINT('"mediaType" requires the "apiVersion" constraint to be set')
  }

  const apiVersion = constraints.apiVersion
  let version
  let mediaType
  if (apiVersion !== null && typeof apiVersion === 'object') {
    version = apiVersion.version
    mediaType = apiVersion.mediaType ?? constraints.mediaType ?? null
  } else {
    version = apiVersion
    mediaType = constraints.mediaType ?? null
  }

  if (typeof version !== 'string' || version.length === 0) {
    throw new FST_ERR_VERSIONING_INVALID_CONSTRAINT('"apiVersion" must be a non-empty string')
  }
  if (mediaType !== null) {
    if (typeof mediaType !== 'string' || !MEDIA_TYPE_REGEX.test(mediaType)) {
      throw new FST_ERR_VERSIONING_INVALID_CONSTRAINT('"mediaType" must be a "type/subtype" string')
    }
    mediaType = mediaType.toLowerCase()
  }

  const normalized = { ...constraints, apiVersion: { version, mediaType } }
  delete normalized.mediaType
  return normalized
}

function onSendMergeVaryAccept (request, reply, payload, done) {
  const vary = reply.getHeader('vary')
  if (vary === undefined) {
    reply.header('vary', 'Accept')
  } else {
    const values = Array.isArray(vary) ? vary : [String(vary)]
    let alreadyPresent = false
    for (const value of values) {
      for (const token of value.split(',')) {
        const normalized = token.trim().toLowerCase()
        if (normalized === '*' || normalized === 'accept') {
          alreadyPresent = true
          break
        }
      }
      if (alreadyPresent) break
    }
    if (!alreadyPresent) {
      reply.header('vary', [...values, 'Accept'])
    }
  }
  done(null, payload)
}

function mediaTypeVersioningPlugin (fastify, options, done) {
  try {
    fastify.addConstraintStrategy(buildMediaTypeVersionStrategy(options))
  } catch (err) {
    done(err)
    return
  }
  done()
}

module.exports = {
  buildMediaTypeVersionStrategy,
  mediaTypeVersioningPlugin,
  normalizeVersioningConstraints,
  onSendMergeVaryAccept,
  parseAcceptHeader
}
