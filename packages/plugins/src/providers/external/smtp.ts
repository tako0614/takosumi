/**
 * SMTP outbound mail surface for the external profile.
 *
 * Operators inject `ExternalSmtpClient` over their MTA (Postfix, Exim,
 * Mailgun via SMTP, AWS SES SMTP relay, etc.). The adapter handles minimal
 * envelope construction and surfaces a typed `send` API to workloads that
 * bind `provider.external.smtp@v1`.
 */

export interface ExternalSmtpAddress {
  readonly address: string;
  readonly name?: string;
}

export interface ExternalSmtpAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Uint8Array;
  readonly contentId?: string;
}

export interface ExternalSmtpMessage {
  readonly from?: ExternalSmtpAddress;
  readonly to: readonly ExternalSmtpAddress[];
  readonly cc?: readonly ExternalSmtpAddress[];
  readonly bcc?: readonly ExternalSmtpAddress[];
  readonly replyTo?: ExternalSmtpAddress;
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly attachments?: readonly ExternalSmtpAttachment[];
}

export interface ExternalSmtpSendResult {
  readonly messageId: string;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
}

export interface ExternalSmtpClient {
  send(message: ExternalSmtpMessage): Promise<ExternalSmtpSendResult>;
  verify?(): Promise<{ readonly ok: boolean; readonly latencyMs?: number }>;
  close?(): Promise<void>;
}

export interface ExternalSmtpAdapterOptions {
  readonly client: ExternalSmtpClient;
  /** Default `From` envelope when the workload omits one. */
  readonly defaultFrom: ExternalSmtpAddress;
}

export class ExternalSmtpAdapter {
  readonly #client: ExternalSmtpClient;
  readonly #defaultFrom: ExternalSmtpAddress;

  constructor(options: ExternalSmtpAdapterOptions) {
    this.#client = options.client;
    this.#defaultFrom = options.defaultFrom;
  }

  async send(
    message: ExternalSmtpMessage,
  ): Promise<ExternalSmtpSendResult> {
    if (message.to.length === 0) {
      throw new Error(
        "external.smtp: message must have at least one recipient",
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
