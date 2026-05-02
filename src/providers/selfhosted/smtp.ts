/**
 * SMTP outbound mail surface for the self-hosted profile.
 *
 * Operators inject `SelfHostedSmtpClient` over their MTA (Postfix, Exim,
 * Mailgun via SMTP, AWS SES SMTP relay, etc.). The adapter handles minimal
 * envelope construction and surfaces a typed `send` API to workloads that
 * bind `provider.selfhosted.smtp@v1`.
 */

export interface SelfHostedSmtpAddress {
  readonly address: string;
  readonly name?: string;
}

export interface SelfHostedSmtpAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Uint8Array;
  readonly contentId?: string;
}

export interface SelfHostedSmtpMessage {
  readonly from?: SelfHostedSmtpAddress;
  readonly to: readonly SelfHostedSmtpAddress[];
  readonly cc?: readonly SelfHostedSmtpAddress[];
  readonly bcc?: readonly SelfHostedSmtpAddress[];
  readonly replyTo?: SelfHostedSmtpAddress;
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly attachments?: readonly SelfHostedSmtpAttachment[];
}

export interface SelfHostedSmtpSendResult {
  readonly messageId: string;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
}

export interface SelfHostedSmtpClient {
  send(message: SelfHostedSmtpMessage): Promise<SelfHostedSmtpSendResult>;
  verify?(): Promise<{ readonly ok: boolean; readonly latencyMs?: number }>;
  close?(): Promise<void>;
}

export interface SelfHostedSmtpAdapterOptions {
  readonly client: SelfHostedSmtpClient;
  /** Default `From` envelope when the workload omits one. */
  readonly defaultFrom: SelfHostedSmtpAddress;
}

export class SelfHostedSmtpAdapter {
  readonly #client: SelfHostedSmtpClient;
  readonly #defaultFrom: SelfHostedSmtpAddress;

  constructor(options: SelfHostedSmtpAdapterOptions) {
    this.#client = options.client;
    this.#defaultFrom = options.defaultFrom;
  }

  async send(
    message: SelfHostedSmtpMessage,
  ): Promise<SelfHostedSmtpSendResult> {
    if (message.to.length === 0) {
      throw new Error(
        "selfhosted.smtp: message must have at least one recipient",
      );
    }
    return await this.#client.send({
      ...message,
      from: message.from ?? this.#defaultFrom,
    });
  }

  async verify(): Promise<
    { readonly ok: boolean; readonly latencyMs?: number } | undefined
  > {
    if (!this.#client.verify) return undefined;
    return await this.#client.verify();
  }

  async close(): Promise<void> {
    if (this.#client.close) await this.#client.close();
  }
}
