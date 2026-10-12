# @italypaleale/email-ses

A tiny, zero-dependency TypeScript library for sending email through the [AWS SES v2](https://docs.aws.amazon.com/ses/latest/APIReference-V2/Welcome.html) HTTP API.

It does not use the AWS SDK. It talks to the SES REST endpoint directly and signs each request with AWS Signature Version 4.

## Authorization

AWS authorizes API requests with an access key ID + secret access key pair (this is the "API key").

Create an IAM user/role with the `ses:SendEmail` permission and pass its credentials to the client.

Temporary STS credentials (with a session token) are also supported.

## Usage

```ts
import { SesClient } from '@italypaleale/email-ses'

const client = new SesClient({
    region: 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        // sessionToken: process.env.AWS_SESSION_TOKEN, // optional, for STS creds
    },
})

const { messageId } = await client.sendEmail({
    from: 'Demo Builder <hello@example.com>',
    to: ['customer@example.com'],
    cc: 'team@example.com',
    replyTo: 'support@example.com',
    subject: 'Your new website is ready',
    text: 'Plain text version of the email.',
    html: '<h1>Your new website is ready</h1><p>Take a look!</p>',
})

console.log('Sent message', messageId)
```

There is also a one-shot helper that constructs a client and sends in a single call:

```ts
import { sendEmail } from '@italypaleale/email-ses'

await sendEmail(
    { region: 'us-east-1', credentials: { accessKeyId, secretAccessKey } },
    { from, to, subject, text }
)
```

## Supported fields

| Field     | Description                                 |
| --------- | ------------------------------------------- |
| `from`    | Sender address (supports `Name <addr>`)     |
| `to`      | One or more "To" recipients                 |
| `cc`      | One or more "CC" recipients                 |
| `replyTo` | One or more "Reply-To" addresses            |
| `subject` | Subject line                                |
| `text`    | Plain-text body (at least one of text/html) |
| `html`    | HTML body (at least one of text/html)       |
| `signal`  | Optional `AbortSignal` to cancel this send  |

Errors from SES surface as a `SesError` carrying the HTTP `statusCode` and the raw `responseBody`.  
A successful HTTP response must contain a non-empty string `MessageId`, otherwise the client throws a `SesResponseError`, which extends `SesError` and retains the status and response body.

## Deadlines and cancellation

Each send has a 10-second deadline covering both the request and reading the response body. Set `timeoutMs` in `SesClientConfig` to change it.

Pass a signal from an `AbortController` to cancel an individual send, or use `AbortSignal.timeout` for a shorter deadline:

```ts
await client.sendEmail({
    from,
    to,
    subject,
    text,
    signal: AbortSignal.timeout(2_000),
})
```

The client deadline rejects with a `TimeoutError`. Caller cancellation uses the signal's reason, which defaults to an `AbortError`.

The client does not retry automatically. SES may already have accepted an email when a send times out, is cancelled, or receives an invalid acknowledgement, so retrying these cases can send duplicates.

## Installation

```sh
pnpm add @italypaleale/email-ses
```

This package is also published on [GitHub Packages](https://docs.github.com/en/packages). To install it from GitHub Packages, point that scope at the GitHub npm registry and authenticate with a token that has `read:packages`:

```ini
# .npmrc
@italypaleale:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

## Publishing

Publishing to GitHub Packages is automated by the [`publish-email-ses`](../.github/workflows/publish-email-ses.yml) GitHub Actions workflow.

To cut a release, bump `version` in `package.json` and push a matching tag:

```sh
git tag v1.0.0
git push origin v1.0.0
```

To publish to NPM, from a local machine:

```sh
pnpm publish
```

## Scripts

- `pnpm build` — clean `dist/`, then type-check and emit production JS + declarations
- `pnpm check` — type-check only
- `pnpm test` — run the vitest suite
