export class IngestWorkflow {
  async run(event) {
    return {
      accepted: true,
      payload: event?.payload ?? null,
    };
  }
}
