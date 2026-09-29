import type { FieldKey, RecordGroup } from '../types';

export const fieldLabels: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];

export const fieldLabelOf = (field: FieldKey) => fieldLabels.find(([key]) => key === field)?.[1] ?? field;

export const parseDate = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

export const recordStatusLabel = (status: string) =>
  status === 'unreviewed' ? '未核对'
    : status === 'confirmed' ? '已确认'
      : status === 'rejected' ? '已忽略'
        : status === 'merged' ? '已合并' : status;

export const matchStatusLabel = (status: string) =>
  status === 'suggested' ? '待复核'
    : status === 'confirmed' ? '已确认'
      : status === 'rejected' ? '已忽略'
        : status === 'merged' ? '已合并' : status;

export const sourceLabel = (source: RecordGroup | 'combine') =>
  source === 'A' ? 'A 来源' : source === 'B' ? 'B 来源' : '双来源拼接';

export const deepClone = <T>(value: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
};

export const newId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};
