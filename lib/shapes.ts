// Shape validation for REST bodies: a declarative checker with a path in every message.
// The suite asserts exact statuses and body shapes, so a mismatch has to name the property.

/** What a value must look like. */
export type Shape =
  | { kind: 'any' }
  | { kind: 'object'; props?: Record<string, Shape>; required?: readonly string[] }
  | { kind: 'array'; items?: Shape; min?: number }
  | { kind: 'string'; nonEmpty?: boolean; oneOf?: readonly string[]; pattern?: RegExp }
  | { kind: 'number'; integer?: boolean; min?: number; max?: number }
  | { kind: 'boolean' };

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** The first mismatch as `<path>: <what>`, or null when the value fits. */
export function checkShape(value: unknown, shape: Shape, path = 'body'): string | null {
  switch (shape.kind) {
    case 'any':
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path}: expected boolean, got ${typeName(value)}`;
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) return `${path}: expected number, got ${typeName(value)}`;
      if (shape.integer === true && !Number.isInteger(value)) return `${path}: expected an integer, got ${String(value)}`;
      if (shape.min !== undefined && value < shape.min) return `${path}: expected at least ${String(shape.min)}, got ${String(value)}`;
      if (shape.max !== undefined && value > shape.max) return `${path}: expected at most ${String(shape.max)}, got ${String(value)}`;
      return null;
    }
    case 'string': {
      if (typeof value !== 'string') return `${path}: expected string, got ${typeName(value)}`;
      if (shape.nonEmpty === true && value === '') return `${path}: expected a non-empty string, got an empty one`;
      if (shape.oneOf !== undefined && !shape.oneOf.includes(value)) return `${path}: expected one of ${shape.oneOf.join(', ')}, got ${JSON.stringify(value)}`;
      if (shape.pattern !== undefined && !shape.pattern.test(value)) return `${path}: ${JSON.stringify(value)} does not match ${String(shape.pattern)}`;
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path}: expected array, got ${typeName(value)}`;
      if (shape.min !== undefined && value.length < shape.min) return `${path}: expected at least ${String(shape.min)} items, got ${String(value.length)}`;
      if (shape.items !== undefined) {
        for (let index = 0; index < value.length; index += 1) {
          const problem = checkShape(value[index], shape.items, `${path}[${String(index)}]`);
          if (problem !== null) return problem;
        }
      }
      return null;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path}: expected object, got ${typeName(value)}`;
      const object = value as Record<string, unknown>;
      for (const key of shape.required ?? Object.keys(shape.props ?? {})) {
        if (!(key in object)) return `${path}.${key}: missing required property`;
      }
      for (const [key, childShape] of Object.entries(shape.props ?? {})) {
        if (!(key in object)) continue;
        const problem = checkShape(object[key], childShape, `${path}.${key}`);
        if (problem !== null) return problem;
      }
      return null;
    }
  }
}
