export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number | null;
}

export interface Queryable {
  query<T = unknown>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}
