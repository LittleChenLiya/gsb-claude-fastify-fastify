'use strict'

const { FST_ERR_RESPONSE_FORMATS_INVALID } = require('./errors')

// Specificity levels of an Accept media range matched against a
// concrete (declared) media type. Higher means more specific.
const SPECIFICITY_NONE = -1
const SPECIFICITY_FULL_WILDCARD = 0 // */*
const SPECIFICITY_TYPE_WILDCARD = 1 // type/*
const SPECIFICITY_EXACT = 2 // type/subtype

const Q_VALUE_RE = /^(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/

/**
 * Parse a single media type (e.g. from a route responseFormats entry or a
 * Content-Type) into its lowercase type/subtype parts.
 * Returns null when the value is not a valid type/subtype pair.
 */
function parseMediaType (value) {
  if (typeof value !== 'string') return null
  const semicolon = value.indexOf(';')
  const mediaType = (semicolon === -1 ? value : value.slice(0, semicolon)).trim().toLowerCase()
  const slash = mediaType.indexOf('/')
  if (slash <= 0 || slash === mediaType.length - 1) return null
  const type = mediaType.slice(0, slash)
  const subtype = mediaType.slice(slash + 1)
  if (type === '*' && subtype !== '*') return null
  return { type, subtype }
}

/**
 * Parse a q-value token. Returns the numeric weight when the token is a
 * syntactically valid qvalue in the inclusive range 0-1, otherwise null.
 * Invalid q-values make the whole Accept entry not acceptable (q = 0).
 */
function parseQValue (raw) {
  if (raw === undefined) return 1
  const value = raw.trim()
  if (!Q_VALUE_RE.test(value)) return null
  const q = Number(value)
  if (Number.isNaN(q) || q < 0 || q > 1) return null
  return q
}

/**
 * Parse an Accept header into an ordered list of media ranges:
 * [{ type, subtype, q }]. Entries are lowercased, entries without a valid
 * type/subtype shape are skipped, entries with an invalid q-value are
 * kept with q = 0 (explicitly not acceptable) and duplicated media ranges
 * are ignored after their first occurrence.
 */
function parseAcceptHeader (header) {
  if (typeof header !== 'string' || header.trim() === '') {
    // No Accept header: the client accepts anything (RFC 9110, section 12.5.1)
    return [{ type: '*', subtype: '*', q: 1 }]
  }

  const ranges = []
  const seen = new Set()

  for (const part of header.split(',')) {
    const tokens = part.split(';')
    const mediaType = parseMediaType(tokens[0])
    if (mediaType === null) continue

    const key = mediaType.type + '/' + mediaType.subtype
    if (seen.has(key)) continue
    seen.add(key)

    let q = 1
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i]
      const eq = token.indexOf('=')
      if (eq === -1) continue
      if (token.slice(0, eq).trim().toLowerCase() !== 'q') continue
      const parsed = parseQValue(token.slice(eq + 1))
      // An invalid q-value marks the entry as not acceptable
      q = parsed === null ? 0 : parsed
      break
    }

    ranges.push({ type: mediaType.type, subtype: mediaType.subtype, q })
  }

  return ranges
}

/**
 * Compute how specifically an Accept media range matches a declared format.
 */
function matchSpecificity (range, format) {
  if (range.type === '*') return SPECIFICITY_FULL_WILDCARD
  if (range.type !== format.type) return SPECIFICITY_NONE
  if (range.subtype === '*') return SPECIFICITY_TYPE_WILDCARD
  if (range.subtype === format.subtype) return SPECIFICITY_EXACT
  return SPECIFICITY_NONE
}

/**
 * Select the declared response format that best satisfies the Accept header.
 *
 * For every declared format the weight is the q-value of the most specific
 * matching media range (exact beats type/* which beats star/star); a format
 * is excluded when no range matches or when that most specific range carries
 * q = 0. Among the remaining formats the highest q-value wins, ties are
 * broken by match specificity and then by route declaration order.
 *
 * Returns the selected format or null when nothing is acceptable (406).
 */
function selectResponseFormat (formats, acceptHeader) {
  const ranges = parseAcceptHeader(acceptHeader)

  let selected = null
  let selectedQ = 0
  let selectedSpecificity = SPECIFICITY_NONE

  for (const format of formats) {
    let q = 0
    let specificity = SPECIFICITY_NONE

    for (const range of ranges) {
      const current = matchSpecificity(range, format)
      if (current > specificity) {
        specificity = current
        q = range.q
      }
    }

    if (specificity === SPECIFICITY_NONE || q <= 0) continue

    if (
      selected === null ||
      q > selectedQ ||
      (q === selectedQ && specificity > selectedSpecificity)
    ) {
      selected = format
      selectedQ = q
      selectedSpecificity = specificity
    }
  }

  return selected
}

/**
 * Validate and normalize the route responseFormats option into a list of
 * { contentType, type, subtype, serializer } entries, preserving the route
 * declaration order.
 */
function buildResponseFormats (responseFormats, method, url) {
  if (!Array.isArray(responseFormats) || responseFormats.length === 0) {
    throw new FST_ERR_RESPONSE_FORMATS_INVALID(
      `responseFormats option of the ${method} ${url} route must be a non-empty array`
    )
  }

  const seen = new Set()
  const formats = []

  for (const entry of responseFormats) {
    if (entry === null || typeof entry !== 'object') {
      throw new FST_ERR_RESPONSE_FORMATS_INVALID(
        `responseFormats entries of the ${method} ${url} route must be objects with a contentType string and a serializer function`
      )
    }

    const mediaType = parseMediaType(entry.contentType)
    if (mediaType === null || mediaType.type === '*' || mediaType.subtype === '*') {
      throw new FST_ERR_RESPONSE_FORMATS_INVALID(
        `responseFormats entries of the ${method} ${url} route must declare a concrete contentType (type/subtype), got ${entry.contentType}`
      )
    }

    if (typeof entry.serializer !== 'function') {
      throw new FST_ERR_RESPONSE_FORMATS_INVALID(
        `responseFormats entry ${mediaType.type}/${mediaType.subtype} of the ${method} ${url} route must provide a serializer function`
      )
    }

    const key = mediaType.type + '/' + mediaType.subtype
    if (seen.has(key)) {
      throw new FST_ERR_RESPONSE_FORMATS_INVALID(
        `responseFormats option of the ${method} ${url} route declares ${key} more than once`
      )
    }
    seen.add(key)

    formats.push({
      contentType: key,
      type: mediaType.type,
      subtype: mediaType.subtype,
      serializer: entry.serializer
    })
  }

  return formats
}

/**
 * Append a field name to the Vary response header, preserving any value
 * that is already set. A star Vary already covers every field.
 */
function appendVaryHeader (reply, field) {
  const existing = reply.getHeader('vary')
  if (existing === undefined) {
    reply.header('vary', field)
    return
  }

  const asString = Array.isArray(existing) ? existing.join(',') : String(existing)
  const fields = asString.split(',').map((value) => value.trim().toLowerCase())
  if (fields.includes('*') || fields.includes(field.toLowerCase())) return

  reply.header('vary', asString + ', ' + field)
}

module.exports = {
  buildResponseFormats,
  selectResponseFormat,
  appendVaryHeader,
  parseAcceptHeader
}
