/** 共享类型：仓储接口与 D1/PG 实现共用，避免循环依赖。 */
export type BudgetFilter = 'positive' | 'zero_or_negative' | 'null';

export interface InsertKeyParams {
	id: string;
	/** SHA-256 十六进制摘要；明文不入库。 */
	keyHash: string;
	/** 展示用前缀（`sk-` + 8 位）。 */
	keyPrefix: string;
	userId: string;
	name?: string | null;
	status?: string;
	metadata?: string | null;
}
