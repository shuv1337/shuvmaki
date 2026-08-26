// Serializes the short window where a process-global environment variable is
// handed to a newly spawned Plannotator bridge. The tail is replaced before
// awaiting, so simultaneous callers cannot both observe a settled promise.

export class PlannotatorStartGate {
  private tail = Promise.resolve()

  async acquire() {
    const previous = this.tail
    let release = () => {}
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    return release
  }
}
