import { signRequest, type AwsCredentials } from './sigv4.js'

export type { AwsCredentials } from './sigv4.js'

/** A single recipient: either a bare address or an address with a display name. */
export type EmailAddress = string

export interface SendEmailOptions {
    /** Sender address. May be formatted as `Name <addr@example.com>`. */
    from: EmailAddress
    /** One or more "To" recipients. */
    to: EmailAddress | EmailAddress[]
    /** Email subject line. */
    subject: string
    /** Plain-text body. At least one of `text` or `html` must be provided. */
    text?: string
    /** HTML body. At least one of `text` or `html` must be provided. */
    html?: string
    /** One or more CC recipients. */
    cc?: EmailAddress | EmailAddress[]
    /** One or more Reply-To addresses. */
    replyTo?: EmailAddress | EmailAddress[]
    /** Optional cancellation signal for this send */
    signal?: AbortSignal
}

export interface SesClientConfig {
    /** AWS region the SES identity lives in, e.g. "us-east-1". */
    region: string
    /** AWS credentials (access key ID + secret access key) authorizing the call. */
    credentials: AwsCredentials
    /**
     * Override the SES endpoint. Defaults to
     * `https://email.<region>.amazonaws.com`. Useful for testing or VPC endpoints.
     */
    endpoint?: string
    /** Optional fetch implementation. Defaults to the global `fetch`. */
    fetch?: typeof fetch
    /** Request deadline in milliseconds, including reading the response body (default: 10,000) */
    timeoutMs?: number
}

export interface SendEmailResult {
    /** The SES-assigned message ID. */
    messageId: string
}

/** Thrown when SES returns a non-2xx response. */
export class SesError extends Error {
    readonly statusCode: number
    readonly responseBody: string

    constructor(message: string, statusCode: number, responseBody: string) {
        super(message)
        this.name = 'SesError'
        this.statusCode = statusCode
        this.responseBody = responseBody
    }
}

/** Thrown when a successful HTTP response does not contain a valid SES acknowledgement */
export class SesResponseError extends SesError {
    constructor(statusCode: number, responseBody: string) {
        super(
            'SES returned an invalid success response: expected a non-empty string MessageId',
            statusCode,
            responseBody
        )
        this.name = 'SesResponseError'
    }
}

const toArray = (value: EmailAddress | EmailAddress[] | undefined): EmailAddress[] =>
    value === undefined ? [] : Array.isArray(value) ? value : [value]

/**
 * A minimal AWS SES v2 client that sends email over the HTTPS API, signing
 * requests with Signature Version 4. It has no runtime dependencies: it relies
 * only on Node's built-in `crypto` module and the global `fetch`.
 */
export class SesClient {
    private readonly region: string
    private readonly credentials: AwsCredentials
    private readonly endpoint: string
    private readonly fetchImpl: typeof fetch
    private readonly timeoutMs: number

    constructor(config: SesClientConfig) {
        if (!config.region) {
            throw new Error('SesClient: `region` is required')
        }
        if (!config.credentials?.accessKeyId || !config.credentials?.secretAccessKey) {
            throw new Error(
                'SesClient: `credentials.accessKeyId` and `credentials.secretAccessKey` are required'
            )
        }

        const timeoutMs = config.timeoutMs ?? 10_000
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
            throw new Error(
                `SesClient: 'timeoutMs' must be an integer between 1 and ${2_147_483_647}`
            )
        }

        this.region = config.region
        this.credentials = config.credentials
        this.endpoint = (config.endpoint ?? `https://email.${config.region}.amazonaws.com`).replace(
            /\/+$/,
            ''
        )

        const fetchImpl = config.fetch ?? globalThis.fetch
        if (typeof fetchImpl !== 'function') {
            throw new Error(
                'SesClient: no global `fetch` available; pass a `fetch` implementation in the config'
            )
        }

        this.fetchImpl = fetchImpl
        this.timeoutMs = timeoutMs
    }

    /** Send a single email. Resolves with the SES message ID. */
    async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
        const to = toArray(options.to)
        if (to.length === 0) {
            throw new Error('sendEmail: at least one `to` recipient is required')
        }
        if (options.text === undefined && options.html === undefined) {
            throw new Error('sendEmail: at least one of `text` or `html` is required')
        }

        const body: Record<string, unknown> = {}
        if (options.text !== undefined) {
            body.Text = { Data: options.text, Charset: 'UTF-8' }
        }
        if (options.html !== undefined) {
            body.Html = { Data: options.html, Charset: 'UTF-8' }
        }

        const destination: Record<string, unknown> = { ToAddresses: to }
        const cc = toArray(options.cc)
        if (cc.length > 0) {
            destination.CcAddresses = cc
        }

        const payload: Record<string, unknown> = {
            FromEmailAddress: options.from,
            Destination: destination,
            Content: {
                Simple: {
                    Subject: { Data: options.subject, Charset: 'UTF-8' },
                    Body: body,
                },
            },
        }

        const replyTo = toArray(options.replyTo)
        if (replyTo.length > 0) {
            payload.ReplyToAddresses = replyTo
        }

        return this.send('/v2/email/outbound-emails', payload, options.signal)
    }

    private async send(
        path: string,
        payload: unknown,
        signal?: AbortSignal
    ): Promise<SendEmailResult> {
        signal?.throwIfAborted()
        const url = `${this.endpoint}${path}`
        const serializedBody = JSON.stringify(payload)

        const signedHeaders = signRequest({
            method: 'POST',
            url,
            region: this.region,
            service: 'ses',
            body: serializedBody,
            credentials: this.credentials,
            headers: { 'content-type': 'application/json' },
        })

        const controller = new AbortController()
        const onAbort = () => controller.abort(signal?.reason)
        signal?.addEventListener('abort', onAbort, { once: true })
        const timeout = setTimeout(() => {
            controller.abort(
                new DOMException(`SES request timed out after ${this.timeoutMs} ms`, 'TimeoutError')
            )
        }, this.timeoutMs)

        try {
            const response = await this.fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...signedHeaders },
                body: serializedBody,
                signal: controller.signal,
            })
            controller.signal.throwIfAborted()

            const responseText = await response.text()
            controller.signal.throwIfAborted()
            if (!response.ok) {
                throw new SesError(
                    `SES request failed with status ${response.status}: ${responseText}`,
                    response.status,
                    responseText
                )
            }

            let parsed: unknown
            try {
                parsed = JSON.parse(responseText)
            } catch {
                throw new SesResponseError(response.status, responseText)
            }
            const messageId =
                typeof parsed === 'object' && parsed !== null && 'MessageId' in parsed
                    ? parsed.MessageId
                    : undefined
            if (typeof messageId !== 'string' || messageId.trim().length === 0) {
                throw new SesResponseError(response.status, responseText)
            }
            return { messageId }
        } catch (error) {
            controller.signal.throwIfAborted()
            throw error
        } finally {
            clearTimeout(timeout)
            signal?.removeEventListener('abort', onAbort)
        }
    }
}

/**
 * Convenience one-shot helper: construct a client and send a single email.
 */
export async function sendEmail(
    config: SesClientConfig,
    options: SendEmailOptions
): Promise<SendEmailResult> {
    return new SesClient(config).sendEmail(options)
}
