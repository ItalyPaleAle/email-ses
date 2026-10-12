import { describe, expect, it } from 'vitest'
import { deriveSigningKey, signRequest } from './sigv4.js'

describe('deriveSigningKey', () => {
    it('matches the signing key from the AWS Signature V4 documentation', () => {
        // Published vector from AWS docs ("Examples of how to derive a signing key").
        const key = deriveSigningKey(
            'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
            '20150830',
            'us-east-1',
            'iam'
        )
        expect(key.toString('hex')).toBe(
            'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9'
        )
    })
})

describe('signRequest', () => {
    const baseInput = {
        method: 'POST',
        url: 'https://email.us-east-1.amazonaws.com/v2/email/outbound-emails',
        region: 'us-east-1',
        service: 'ses',
        body: '{"hello":"world"}',
        credentials: {
            accessKeyId: 'AKIDEXAMPLE',
            secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        },
        headers: { 'content-type': 'application/json' },
        date: new Date('2015-08-30T12:36:00.000Z'),
    }

    it('produces deterministic, well-formed signing headers', () => {
        const headers = signRequest(baseInput)

        expect(headers['x-amz-date']).toBe('20150830T123600Z')
        // The hash of the body is stable for a fixed payload.
        expect(headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/)

        // Authorization line: algorithm, credential scope, signed headers, 64-hex signature.
        expect(headers.Authorization).toMatch(
            /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/
        )
    })

    it('is stable across calls with the same input (regression pin)', () => {
        const a = signRequest(baseInput)
        const b = signRequest(baseInput)
        expect(a.Authorization).toBe(b.Authorization)
        // Pinned signature for the fixed inputs above; guards against accidental
        // changes to the canonicalization or signing algorithm.
        const signature = a.Authorization.match(/Signature=([0-9a-f]{64})$/)?.[1]
        expect(signature).toBe('6f4cb22af95b04417ce966aebbe554f8b3f58d03e0340c496dc34a076417e725')
    })

    it('includes the session token as a signed header when present', () => {
        const headers = signRequest({
            ...baseInput,
            credentials: { ...baseInput.credentials, sessionToken: 'FQoGZXIvYXdzEXAMPLE' },
        })
        expect(headers['x-amz-security-token']).toBe('FQoGZXIvYXdzEXAMPLE')
        expect(headers.Authorization).toContain('x-amz-security-token')
    })

    it('changes the signature when the body changes', () => {
        const a = signRequest(baseInput)
        const b = signRequest({ ...baseInput, body: '{"hello":"there"}' })
        expect(a.Authorization).not.toBe(b.Authorization)
    })
})
