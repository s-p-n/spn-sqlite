/**
 * Compiles tagged template literals into SQL + bound values.
 *
 * Example:
 *   compile`SELECT * FROM users WHERE id = ${1}`
 * →
 *   { sql: "SELECT * FROM users WHERE id = ?", values: [1] }
 */
export class SQLCompiler {
  static compile(strings, values) {
    // Fast path: no parameters
    if (values.length === 0) {
      return {
        sql: strings.join(''),
        values: []
      };
    }

    let sql = strings[0];
    for (let i = 0; i < values.length; i++) {
      sql += '?' + strings[i + 1];
    }

    return { sql, values };
  }
}
