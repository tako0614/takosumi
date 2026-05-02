export type NotificationSeverity = "info" | "warning" | "error";

export interface NotificationInput {
  readonly type: string;
  readonly subject?: string;
  readonly body?: string;
  readonly severity?: NotificationSeverity;
  readonly metadata?: Record<string, unknown>;
}

export interface NotificationRecord extends NotificationInput {
  readonly id: string;
  readonly severity: NotificationSeverity;
  readonly createdAt: string;
  readonly metadata: Record<string, unknown>;
}

export interface NotificationPort {
  publish(input: NotificationInput): Promise<NotificationRecord>;
}
