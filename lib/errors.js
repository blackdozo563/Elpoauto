export class EditError extends Error {
  constructor(code, message, details = []) { super(message); this.name = 'EditError'; this.code = code; this.details = details; }
}
export function check(condition, code, message, details) {
  if (!condition) throw new EditError(code, message, details);
}
