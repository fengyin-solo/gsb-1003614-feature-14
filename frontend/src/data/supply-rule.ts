import type { EntryRow } from './types'

// 防火物资动态储备口径：统一阈值、判定规则、数量校验都收敛在这里，页面与台账共用同一套规则。

export const SUPPLY_CATEGORY_FIELD = '物资类别'
export const SUPPLY_FARM_FIELD = '储备林场'
export const SUPPLY_WARN_FIELD = '预警储备量'
export const SUPPLY_ACTUAL_FIELD = '实际储备量'
export const SUPPLY_DEMAND_FIELD = '林场需求'

// 统一阈值：所有数量入口（盘点、补充、调拨、登记）共用，超出范围一律不允许保存。
export const QUANTITY_MIN = 0
export const QUANTITY_MAX = 9999

// 判定规则：以预警储备量与林场需求的较大值作为基准线，实际储备量按比例落入三档。
export const SUFFICIENT_RATIO = 1 // 达到基准线 → 充足
export const LOW_RATIO = 0.8 // 基准线的 80%~100% → 偏低；不足 80% → 需补充

export const SUPPLY_STATUSES = ['充足', '偏低', '需补充', '已过期'] as const
export type SupplyStatus = (typeof SUPPLY_STATUSES)[number]

export type QuantityCheck = { ok: true; value: number } | { ok: false; message: string }

// 统一数量校验：非负整数且落在 [0, 9999]，超出范围不允许保存。
export function checkQuantity(raw: unknown, label = '数量'): QuantityCheck {
  const text = String(raw ?? '').trim()
  if (text === '') {
    return { ok: false, message: `${label}不能为空` }
  }
  if (!/^\d+$/.test(text)) {
    return { ok: false, message: `${label}必须是 0-${QUANTITY_MAX} 的非负整数` }
  }
  const value = Number(text)
  if (value < QUANTITY_MIN || value > QUANTITY_MAX) {
    return { ok: false, message: `${label}超出允许范围（${QUANTITY_MIN}-${QUANTITY_MAX}），不允许保存` }
  }
  return { ok: true, value }
}

export function toQuantity(raw: unknown): number {
  const result = checkQuantity(raw)
  return result.ok ? result.value : 0
}

// 中位数：历史缺少预警储备量时，按同类物资（同类别且有有效预警值）的中位数兼容补齐。
export function median(values: number[]): number {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (list.length === 0) {
    return 0
  }
  const middle = Math.floor(list.length / 2)
  return list.length % 2 === 0 ? Math.round((list[middle - 1] + list[middle]) / 2) : list[middle]
}

// 同类别预警储备量中位数：只统计同类别、预警值有效的在库物资。
export function categoryWarnMedian(rows: EntryRow[], category: string, excludeId?: number): number {
  const values = rows
    .filter((row) => String(row[SUPPLY_CATEGORY_FIELD] ?? '') === category)
    .filter((row) => excludeId === undefined || Number(row.id) !== excludeId)
    .map((row) => toQuantity(row[SUPPLY_WARN_FIELD]))
    .filter((value) => value > 0)
  return median(values)
}

export type SupplyEvaluation = {
  warn: number // 生效预警储备量（历史缺值已按同类中位数兼容）
  warnFallback: boolean // 是否走了中位数兼容
  demand: number
  actual: number
  baseline: number // 基准线 = max(预警, 林场需求)
  ratio: number
  suggestion: SupplyStatus
  gap: number // 距基准线的缺口
}

// 动态储备判定：比较预警储备量与实际储备量，并结合林场需求给出充足 / 偏低 / 需补充建议。
export function evaluateSupply(row: EntryRow, allRows: EntryRow[] = []): SupplyEvaluation {
  const category = String(row[SUPPLY_CATEGORY_FIELD] ?? '')
  let warn = toQuantity(row[SUPPLY_WARN_FIELD])
  let warnFallback = false
  if (warn <= 0) {
    warn = categoryWarnMedian(allRows, category, Number(row.id))
    warnFallback = true
  }
  const demand = toQuantity(row[SUPPLY_DEMAND_FIELD])
  const actual = toQuantity(row[SUPPLY_ACTUAL_FIELD])
  const baseline = Math.max(warn, demand)
  const ratio = baseline === 0 ? 1 : actual / baseline
  // 已过期物资不参与三档判定，单独保持「已过期」。
  let suggestion: SupplyStatus
  if (String(row.status) === '已过期') {
    suggestion = '已过期'
  } else if (ratio >= SUFFICIENT_RATIO) {
    suggestion = '充足'
  } else if (ratio >= LOW_RATIO) {
    suggestion = '偏低'
  } else {
    suggestion = '需补充'
  }
  return {
    warn,
    warnFallback,
    demand,
    actual,
    baseline,
    ratio,
    suggestion,
    gap: Math.max(0, baseline - actual),
  }
}

// 已过期物资不参与三档判定，单独保留「已过期」状态。
export function supplySuggestion(row: EntryRow, allRows: EntryRow[] = []): SupplyStatus {
  if (String(row.status) === '已过期') {
    return '已过期'
  }
  return evaluateSupply(row, allRows).suggestion
}
