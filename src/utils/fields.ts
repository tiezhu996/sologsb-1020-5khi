import type { FieldKey } from '../types';

export const fieldLabels: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];

export const fieldLabel = (field: FieldKey) => fieldLabels.find(([key]) => key === field)?.[1] ?? field;
