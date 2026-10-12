import { createHash, createHmac } from 'node:crypto'

/**
 * AWS credentials used to authorize requests. AWS authorizes API calls with an
 * access key ID + secret access key pair (optionally a session token). This is
 * the "API key" that grants permission to call SES.
 */
export interface AwsCredentials {
    accessKeyId: string
    secretAccessKey: string
    /** Optional session token for temporary (STS) credentials. */
    sessionToken?: string
}

export interface SignRequestInput {
    method: string
    /** Fully qualified URL, e.g. https://email.us-east-1.amazonaws.com/v2/email/outbound-emails */
    url: string
    region: string
    service: string
    /** Request body. Empty string for bodyless requests. */
    body: string
    credentials: AwsCredentials
    /** Additional headers to include in the request (and the signature). */
    headers?: Record<string, string>
    /** Override the signing time. Mainly useful for deterministic tests. */
    date?: Date
}

const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex')

const hmac = (key: string | Buffer, data: string): Buffer =>
    createHmac('sha256', key).update(data, 'utf8').digest()

/** Format a Date as the two AWS timestamps used by SigV4. */
function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
    const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
    // iso is now e.g. "20240131T120000Z"
    return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

/**
 * Derive the SigV4 signing key by successively HMAC-ing the date, region,
 * service and the literal `aws4_request`, seeded with the secret access key.
 * Exported so the signing core can be tested against AWS's published vectors.
 */
export function deriveSigningKey(
    secretAccessKey: string,
    dateStamp: string,
    region: string,
    service: string
): Buffer {
    const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp)
    const kRegion = hmac(kDate, region)
    const kService = hmac(kRegion, service)
    return hmac(kService, 'aws4_request')
}

/**
 * Sign a request with AWS Signature Version 4 and return the headers that must
 * be sent with the request (including Authorization).
 */
export function signRequest(input: SignRequestInput): Record<string, string> {
    const { method, url, region, service, body, credentials } = input
    const parsed = new URL(url)
    const { amzDate, dateStamp } = formatAmzDate(input.date ?? new Date())
    const payloadHash = sha256Hex(body)

    // Collect headers, lower-casing names for canonicalization.
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(input.headers ?? {})) {
        headers[name.toLowerCase()] = value.trim()
    }
    headers['host'] = parsed.host
    headers['x-amz-date'] = amzDate
    headers['x-amz-content-sha256'] = payloadHash
    if (credentials.sessionToken) {
        headers['x-amz-security-token'] = credentials.sessionToken
    }

    const sortedHeaderNames = Object.keys(headers).toSorted()
    const canonicalHeaders = sortedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join('')
    const signedHeaders = sortedHeaderNames.join(';')

    const canonicalRequest = [
        method.toUpperCase(),
        parsed.pathname || '/',
        parsed.searchParams.toString(),
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n')

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        sha256Hex(canonicalRequest),
    ].join('\n')

    const signingKey = deriveSigningKey(credentials.secretAccessKey, dateStamp, region, service)
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')

    const authorization =
        `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`

    // Return the headers that the caller should attach to the outgoing request.
    const outgoing: Record<string, string> = {
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        Authorization: authorization,
    }
    if (credentials.sessionToken) {
        outgoing['x-amz-security-token'] = credentials.sessionToken
    }

    return outgoing
}
