import type { EntryRow } from '@/data/types'

/**
 * 防火物资动态储备口径：全系统唯一的阈值、判定规则与数量校验都收敛在这里，
 * 物资页、火情调拨、队伍领用、其余模块的领用清单都走同一份逻辑，避免各写一套。
 */

// —— 统一阈值与取值范围（超出范围不允许保存）——
export const QUANTITY_MIN = 0
export const QUANTITY_MAX = 999999
export const REPLENISH_MAX = 99999

/** 偏低阈值：实际量达到动态基线的该比例（含）以上算偏低，以下算需补充 */
export const LOW_RATIO = 0.8

export const SUPPLY_STATUSES = ['充足', '偏低', '需补充', '已过期'] as const
export type SupplyStatus = (typeof SUPPLY_STATUSES)[number]

/** 数量字段允许的写法：空串/非数字视为“未填”，其余必须是范围内的非负整数 */
export function parseQuantity(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? value : null
  }
  const text = String(value).trim()
  if (!/^\d+$/.test(text)) {
    return null
  }
  return Number(text)
}

export function inQuantityRange(value: number, max: number = QUANTITY_MAX): boolean {
  return Number.isInteger(value) && value >= QUANTITY_MIN && value <= max
}

/** 登记/编辑保存前的统一校验，返回错误信息；通过返回 null */
export function validateQuantityInput(input: {
  warning: number | null
  actual: number
  demand: number | null
}): string | null {
  if (input.warning !== null && !inQuantityRange(input.warning)) {
    return `预警储备量必须是 ${QUANTITY_MIN}~${QUANTITY_MAX} 的整数`
  }
  if (!inQuantityRange(input.actual)) {
    return `实际储备量必须是 ${QUANTITY_MIN}~${QUANTITY_MAX} 的整数`
  }
  if (input.demand !== null && !inQuantityRange(input.demand)) {
    return `林场需求量必须是 ${QUANTITY_MIN}~${QUANTITY_MAX} 的整数`
  }
  return null
}

/**
 * 历史兼容：预警储备量缺失/非法时，取同类物资预警储备量的中位数。
 * peers 是同一物资类别下的其余物资（可含自身，计算时会剔除自身缺失项）。
 * 整类都没有可用预警量时回退到 null，由判定逻辑按需求量兜底。
 */
export function medianWarningOfCategory(category: string, all: EntryRow[], selfId?: number): number | null {
  const values = all
    .filter((row) => String(row['物资类别'] ?? '') === category && (selfId === undefined || Number(row.id) !== selfId))
    .map((row) => parseQuantity(row['预警储备量']))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)
  if (!values.length) {
    return null
  }
  const mid = Math.floor(values.length / 2)
  return values.length % 2 === 0 ? Math.round((values[mid - 1] + values[mid]) / 2) : values[mid]
}

export type SupplyEvaluation = {
  warningRaw: number | null
  /** 实际参与判定的预警储备量（历史缺失已按同类中位数兼容） */
  warningEffective: number | null
  demand: number | null
  /** 动态基线 = 预警储备量与林场需求量取大值 */
  baseline: number
  actual: number
  ratio: number
  status: SupplyStatus
  advice: string
  gap: number
}

/**
 * 动态储备判定：比较预警储备量与实际储备量，并结合林场需求给出口径建议。
 * 已过期物资不参与储备充足性判定，单独挂牌。
 */
export function evaluateSupply(row: EntryRow, all: EntryRow[]): SupplyEvaluation {
  const actual = parseQuantity(row['实际储备量']) ?? 0
  const warningRaw = parseQuantity(row['预警储备量'])
  const demand = parseQuantity(row['林场需求量'])
  const warningEffective =
    warningRaw !== null ? warningRaw : medianWarningOfCategory(String(row['物资类别'] ?? ''), all, Number(row.id))
  const baseline = Math.max(warningEffective ?? 0, demand ?? 0)
  const ratio = baseline === 0 ? 1 : actual / baseline
  const gap = Math.max(baseline - actual, 0)

  let status: SupplyStatus
  let advice: string
  if (String(row.status) === '已过期' || row['已过期'] === true) {
    status = '已过期'
    advice = '物资已过期，不得参与调拨与领用，请先处置过期库存'
  } else if (baseline === 0) {
    // 预警量与需求都缺失：无法形成动态基线，保守提示需补充核定
    status = actual > 0 ? '充足' : '需补充'
    advice = actual > 0 ? '预警储备量与林场需求量均未核定，当前按实际库存暂记充足，请尽快补录口径' : '缺少动态储备基线且无库存，需补充并核定口径'
  } else if (ratio >= 1) {
    status = '充足'
    advice = `实际储备满足动态基线 ${baseline}（预警${warningEffective ?? 0}/需求${demand ?? 0}），可正常调拨`
  } else if (ratio >= LOW_RATIO) {
    status = '偏低'
    advice = `实际储备低于动态基线 ${baseline}，缺口 ${gap}，建议发起补充`
  } else {
    status = '需补充'
    advice = `实际储备不足基线的 ${LOW_RATIO * 100}%，缺口 ${gap}，需立即补充`
  }

  return { warningRaw, warningEffective, demand, baseline, actual, ratio, status, advice, gap }
}

/** 火情处置调拨配方：按火势等级生成物资调拨清单（数量为每起火情的标准调拨量） */
export const FIRE_DISPATCH_RECIPE: { match: (level: string) => boolean; items: Record<string, number> }[] = [
  { match: (level) => level.includes('弱') || level === '三级', items: { '风力灭火机': 2, '灭火拖把': 10, '防护手套': 20 } },
  { match: (level) => level.includes('中') || level === '二级', items: { '风力灭火机': 4, '灭火拖把': 20, '防护手套': 40, '消防水带': 6 } },
  { match: (level) => level.includes('强') || level.includes('烈') || level === '一级', items: { '风力灭火机': 8, '灭火拖把': 40, '防护手套': 80, '消防水带': 12, '高压水泵': 2 } },
]

export function dispatchRecipeFor(level: string): Record<string, number> {
  const hit = FIRE_DISPATCH_RECIPE.find((recipe) => recipe.match(level))
  return hit ? { ...hit.items } : { '风力灭火机': 2, '灭火拖把': 10, '防护手套': 20 }
}
