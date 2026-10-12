import { afterEach, describe, expect, it, vi } from 'vitest'
import { SesClient, SesError, SesResponseError, sendEmail } from './index.js'

const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretEXAMPLE' }

/** Build a mock fetch that records the last call and returns the given response. */
function mockFetch(response: { ok: boolean; status: number; text: string }) {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} })
        return {
            ok: response.ok,
            status: response.status,
            text: async () => response.text,
        } as Response
    })
    return { fn: fn as unknown as typeof fetch, calls }
}

const okResponse = { ok: true, status: 200, text: JSON.stringify({ MessageId: 'msg-123' }) }
const email = { from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't' }

function waitForAbort<T>(signal: AbortSignal | null | undefined): Promise<T> {
    if (!signal) {
        throw new Error('Expected a request signal')
    }
    signal.throwIfAborted()
    return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
}

describe('SesClient constructor', () => {
    it('requires a region', () => {
        expect(() => new SesClient({ region: '', credentials } as never)).toThrow(/region/)
    })

    it('requires credentials', () => {
        expect(
            () =>
                new SesClient({
                    region: 'us-east-1',
                    credentials: { accessKeyId: '', secretAccessKey: '' },
                })
        ).toThrow(/credentials/)
    })

    it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])(
        'rejects an invalid timeout of %s ms',
        (timeoutMs) => {
            expect(() => new SesClient({ region: 'us-east-1', credentials, timeoutMs })).toThrow(
                /timeoutMs/
            )
        }
    )
})

describe('SesClient.sendEmail', () => {
    it('posts to the SES v2 endpoint for the region', async () => {
        const { fn, calls } = mockFetch(okResponse)
        const client = new SesClient({ region: 'eu-west-1', credentials, fetch: fn })
        await client.sendEmail({ from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't' })
        expect(calls[0].url).toBe('https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails')
        expect((calls[0].init.method ?? '').toUpperCase()).toBe('POST')
    })

    it('attaches SigV4 auth headers', async () => {
        const { fn, calls } = mockFetch(okResponse)
        const client = new SesClient({ region: 'us-east-1', credentials, fetch: fn })
        await client.sendEmail({ from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't' })
        const headers = calls[0].init.headers as Record<string, string>
        expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//)
        expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
        expect(headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/)
        expect(headers['content-type']).toBe('application/json')
    })

    it('builds the full SES payload with all supported fields', async () => {
        const { fn, calls } = mockFetch(okResponse)
        const client = new SesClient({ region: 'us-east-1', credentials, fetch: fn })
        await client.sendEmail({
            from: 'Demo <hello@example.com>',
            to: ['a@example.com', 'b@example.com'],
            cc: 'c@example.com',
            replyTo: ['r@example.com'],
            subject: 'Hi',
            text: 'plain',
            html: '<b>html</b>',
        })
        const body = JSON.parse(calls[0].init.body as string)
        expect(body).toEqual({
            FromEmailAddress: 'Demo <hello@example.com>',
            Destination: {
                ToAddresses: ['a@example.com', 'b@example.com'],
                CcAddresses: ['c@example.com'],
            },
            ReplyToAddresses: ['r@example.com'],
            Content: {
                Simple: {
                    Subject: { Data: 'Hi', Charset: 'UTF-8' },
                    Body: {
                        Text: { Data: 'plain', Charset: 'UTF-8' },
                        Html: { Data: '<b>html</b>', Charset: 'UTF-8' },
                    },
                },
            },
        })
    })

    it('omits Cc/ReplyTo when not provided and supports text-only bodies', async () => {
        const { fn, calls } = mockFetch(okResponse)
        const client = new SesClient({ region: 'us-east-1', credentials, fetch: fn })
        await client.sendEmail({ from: 'a@b.c', to: 'd@e.f', subject: 's', text: 'only text' })
        const body = JSON.parse(calls[0].init.body as string)
        expect(body.Destination.CcAddresses).toBeUndefined()
        expect(body.ReplyToAddresses).toBeUndefined()
        expect(body.Content.Simple.Body).toEqual({ Text: { Data: 'only text', Charset: 'UTF-8' } })
    })

    it('supports html-only bodies', async () => {
        const { fn, calls } = mockFetch(okResponse)
        const client = new SesClient({ region: 'us-east-1', credentials, fetch: fn })
        await client.sendEmail({ from: 'a@b.c', to: 'd@e.f', subject: 's', html: '<p>hi</p>' })
        const body = JSON.parse(calls[0].init.body as string)
        expect(body.Content.Simple.Body).toEqual({ Html: { Data: '<p>hi</p>', Charset: 'UTF-8' } })
    })

    it('returns the SES message id', async () => {
        const { fn } = mockFetch(okResponse)
        const client = new SesClient({ region: 'us-east-1', credentials, fetch: fn })
        const result = await client.sendEmail({
            from: 'a@b.c',
            to: 'd@e.f',
            subject: 's',
            text: 't',
        })
        expect(result.messageId).toBe('msg-123')
    })

    it.each([
        '',
        '<html>upstream error</html>',
        '{}',
        'null',
        '[]',
        '"msg-123"',
        '{"MessageId":null}',
        '{"MessageId":123}',
        '{"MessageId":false}',
        '{"MessageId":""}',
        '{"MessageId":"   "}',
    ])('rejects an invalid success acknowledgement: %j', async (text) => {
        const { fn } = mockFetch({ ok: true, status: 200, text })
        const client = new SesClient({ region: 'us-east-1', credentials, fetch: fn })
        const err = await client.sendEmail(email).catch((error) => error)
        expect(err).toBeInstanceOf(SesResponseError)
        expect(err).toBeInstanceOf(SesError)
        expect(err.name).toBe('SesResponseError')
        expect(err.statusCode).toBe(200)
        expect(err.responseBody).toBe(text)
        expect(err.message).toMatch(/MessageId/)
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('throws when there are no recipients', async () => {
        const { fn } = mockFetch(okResponse)
        const client = new SesClient({ region: 'us-east-1', credentials, fetch: fn })
        await expect(
            client.sendEmail({ from: 'a@b.c', to: [], subject: 's', text: 't' })
        ).rejects.toThrow(/recipient/)
    })

    it('throws when neither text nor html is provided', async () => {
        const { fn } = mockFetch(okResponse)
        const client = new SesClient({ region: 'us-east-1', credentials, fetch: fn })
        await expect(
            client.sendEmail({ from: 'a@b.c', to: 'd@e.f', subject: 's' })
        ).rejects.toThrow(/text.*html/)
    })

    it('throws a SesError carrying status code and body on failure', async () => {
        const { fn } = mockFetch({ ok: false, status: 403, text: '{"message":"AccessDenied"}' })
        const client = new SesClient({ region: 'us-east-1', credentials, fetch: fn })
        const err = await client
            .sendEmail({ from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't' })
            .catch((e) => e)
        expect(err).toBeInstanceOf(SesError)
        expect(err.statusCode).toBe(403)
        expect(err.responseBody).toBe('{"message":"AccessDenied"}')
    })

    it('strips a trailing slash from a custom endpoint', async () => {
        const { fn, calls } = mockFetch(okResponse)
        const client = new SesClient({
            region: 'us-east-1',
            credentials,
            endpoint: 'https://ses.internal.example.com/',
            fetch: fn,
        })
        await client.sendEmail({ from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't' })
        expect(calls[0].url).toBe('https://ses.internal.example.com/v2/email/outbound-emails')
    })
})

describe('request deadlines and cancellation', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('times out a stalled request after 10 seconds by default', async () => {
        vi.useFakeTimers()
        let requestSignal: AbortSignal | null | undefined
        const fn: typeof fetch = vi.fn(async (_url, init) => {
            requestSignal = init?.signal
            return waitForAbort<Response>(requestSignal)
        })
        const client = new SesClient({ region: 'us-east-1', credentials, fetch: fn })
        const pending = client.sendEmail(email)
        const rejected = expect(pending).rejects.toMatchObject({
            name: 'TimeoutError',
            message: /10000 ms/,
        })
        await vi.advanceTimersByTimeAsync(9_999)
        expect(requestSignal?.aborted).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        await rejected
        expect(requestSignal?.aborted).toBe(true)
        expect(fn).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)
    })

    it.each([200, 403])(
        'keeps a configured deadline active while reading a stalled HTTP %s body',
        async (status) => {
            vi.useFakeTimers()
            const fn: typeof fetch = vi.fn(async (_url, init) => {
                return {
                    ok: status === 200,
                    status,
                    text: () => waitForAbort<string>(init?.signal),
                } as Response
            })
            const client = new SesClient({
                region: 'us-east-1',
                credentials,
                fetch: fn,
                timeoutMs: 25,
            })
            const pending = client.sendEmail(email)
            const rejected = expect(pending).rejects.toMatchObject({
                name: 'TimeoutError',
                message: /25 ms/,
            })
            await vi.advanceTimersByTimeAsync(25)
            await rejected
            expect(fn).toHaveBeenCalledTimes(1)
            expect(vi.getTimerCount()).toBe(0)
        }
    )

    it('does not fetch when the caller signal is already aborted', async () => {
        vi.useFakeTimers()
        const { fn } = mockFetch(okResponse)
        const client = new SesClient({ region: 'us-east-1', credentials, fetch: fn })
        const reason = new Error('Caller cancelled')
        await expect(
            client.sendEmail({ ...email, signal: AbortSignal.abort(reason) })
        ).rejects.toBe(reason)
        expect(fn).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
    })

    it.each(['request', 'body'])(
        'preserves the caller cancellation reason during the %s',
        async (phase) => {
            vi.useFakeTimers()
            const controller = new AbortController()
            const fn: typeof fetch = vi.fn(async (_url, init) => {
                if (phase === 'request') {
                    return waitForAbort<Response>(init?.signal)
                }
                return {
                    ok: true,
                    status: 200,
                    text: () => waitForAbort<string>(init?.signal),
                } as Response
            })
            const client = new SesClient({ region: 'us-east-1', credentials, fetch: fn })
            const pending = client.sendEmail({ ...email, signal: controller.signal })
            const reason = new Error('Caller cancelled')
            const rejected = expect(pending).rejects.toBe(reason)
            await vi.advanceTimersByTimeAsync(0)
            controller.abort(reason)
            await rejected
            expect(vi.getTimerCount()).toBe(0)
        }
    )

    it.each(['deadline', 'caller'])(
        'preserves the %s reason when the body reader throws an AbortError',
        async (source) => {
            vi.useFakeTimers()
            const controller = new AbortController()
            const fn: typeof fetch = vi.fn(async (_url, init) => {
                return {
                    ok: true,
                    status: 200,
                    text: async () => {
                        try {
                            return await waitForAbort<string>(init?.signal)
                        } catch {
                            throw new DOMException('The body was aborted', 'AbortError')
                        }
                    },
                } as Response
            })
            const client = new SesClient({
                region: 'us-east-1',
                credentials,
                fetch: fn,
                timeoutMs: 25,
            })
            const pending = client.sendEmail({ ...email, signal: controller.signal })
            const reason = new Error('Caller cancelled')
            const rejected =
                source === 'caller'
                    ? expect(pending).rejects.toBe(reason)
                    : expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
            await vi.advanceTimersByTimeAsync(0)
            if (source === 'caller') {
                controller.abort(reason)
            } else {
                await vi.advanceTimersByTimeAsync(25)
            }
            await rejected
            expect(vi.getTimerCount()).toBe(0)
        }
    )

    it.each([
        okResponse,
        { ok: false, status: 403, text: 'denied' },
        { ok: true, status: 200, text: '{}' },
    ])('cleans up the deadline and caller listener after settling: %j', async (response) => {
        vi.useFakeTimers()
        const controller = new AbortController()
        const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
        const { fn, calls } = mockFetch(response)
        const client = new SesClient({ region: 'us-east-1', credentials, fetch: fn })
        await client.sendEmail({ ...email, signal: controller.signal }).catch(() => {})
        expect(vi.getTimerCount()).toBe(0)
        expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
        const requestSignal = calls[0].init.signal
        expect(requestSignal?.aborted).toBe(false)
        expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty('signal')
        controller.abort()
        await vi.advanceTimersByTimeAsync(10_000)
        expect(requestSignal?.aborted).toBe(false)
    })

    it.each(['request', 'body'])(
        'preserves a %s failure and cleans up its timer',
        async (phase) => {
            vi.useFakeTimers()
            const failure = new Error('Connection closed')
            const fn: typeof fetch = vi.fn(async () => {
                if (phase === 'request') {
                    throw failure
                }
                return {
                    ok: true,
                    status: 200,
                    text: async (): Promise<string> => {
                        throw failure
                    },
                } as Response
            })
            const client = new SesClient({ region: 'us-east-1', credentials, fetch: fn })
            await expect(client.sendEmail(email)).rejects.toBe(failure)
            expect(vi.getTimerCount()).toBe(0)
        }
    )

    it('keeps concurrent sends independent when one is cancelled', async () => {
        vi.useFakeTimers()
        const controller = new AbortController()
        const fn: typeof fetch = vi.fn(async (_url, init) => {
            return waitForAbort<Response>(init?.signal)
        })
        const client = new SesClient({ region: 'us-east-1', credentials, fetch: fn, timeoutMs: 25 })
        const cancelled = client.sendEmail({ ...email, signal: controller.signal })
        const timedOut = client.sendEmail(email)
        const cancelledResult = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
        const timedOutResult = expect(timedOut).rejects.toMatchObject({ name: 'TimeoutError' })
        controller.abort()
        await cancelledResult
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersByTimeAsync(25)
        await timedOutResult
        expect(vi.getTimerCount()).toBe(0)
    })
})

describe('sendEmail helper', () => {
    it('constructs a client and sends', async () => {
        const { fn, calls } = mockFetch(okResponse)
        const result = await sendEmail(
            { region: 'us-east-1', credentials, fetch: fn },
            { from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't' }
        )
        expect(result.messageId).toBe('msg-123')
        expect(calls).toHaveLength(1)
    })
})
