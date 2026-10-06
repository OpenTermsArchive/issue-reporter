export class RunChangedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RunChangedError';
  }
}
