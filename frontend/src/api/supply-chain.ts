import { listRows, saveRows } from '@/data/local-store'
import { addRequisition, addStocktake, addTodo, completeTodo, hasRequisition, listRequisitions, pendingTodos } from '@/data/ledger-store'
import {
  checkQuantity,
  evaluateSupply,
  SUPPLY_ACTUAL_FIELD,
  SUPPLY_CATEGORY_FIELD,
  SUPPLY_DEMAND_FIELD,
  SUPPLY_FARM_FIELD,
  SUPPLY_WARN_FIELD,
  supplySuggestion,
  toQuantity,
} from '@/data/supply-rule'
import type { ActionResult, EntryRow, EquipmentTodo, Requisition } from '@/data/types'

// 物资状态 → 火情处置调拨 → 扑火队伍装备待办 / 队伍领用清单 的完整调用链都收敛在本文件。
// 约定：所有会扣减库存/入库的动作一律走幂等键，重复提交只生效一次。

type SupplyMutation = {
  ok: boolean
  message: string
  requisition?: Requisition
  todo?: EquipmentTodo
  allocations?: Requisition[]
}

function fail(message: string): SupplyMutation {
  return { ok: false, message }
}

function supplyRows(): EntryRow[] {
  return listRows('supply')
}

function findSupply(id: number): { rows: EntryRow[]; row?: EntryRow; index: number } {
  const rows = supplyRows()
  const index = rows.findIndex((item) => Number(item.id) === id)
  return { rows, row: index >= 0 ? rows[index] : undefined, index }
}

function persistSupplies(rows: EntryRow[]): void {
  saveRows('supply', rows)
}

// 数量变更后按统一阈值重算状态；任何数量变动都会让旧的人工盘点结论失效，回到系统口径。
function applyQuantity(row: EntryRow, rows: EntryRow[]): void {
  if (String(row.status) !== '已过期') {
    row.status = supplySuggestion(row, rows)
    row.pending = row.status !== '充足'
    row['盘点结论'] = ''
    row['盘点备注'] = ''
  }
}

// 队伍领用清单中已出库（调拨/领用）的物资数量。
export function issuedSupplyQty(supplyId: number): number {
  const id = Number(supplyId)
  return issuedLedger()
    .filter((item) => item.entryType === '物资' && item.itemId === id)
    .reduce((sum, item) => sum + item.qty, 0)
}

// 可用量 = 实际储备量 - 已出库未归还量；队伍领用清单变化后实时重算。
export function availableSupply(supplyId: number): number {
  const { row } = findSupply(supplyId)
  if (!row) {
    return 0
  }
  const actual = toQuantity(row[SUPPLY_ACTUAL_FIELD])
  return Math.max(0, actual - issuedSupplyQty(supplyId))
}

export function availableEquipment(equipmentId: number): number {
  const row = listRows('equipment').find((item) => Number(item.id) === Number(equipmentId))
  // 装备按件管理：「可用」即 1，已领用/待检修/已报废即 0。
  return row && String(row.status) === '可用' ? 1 : 0
}

function issuedLedger(): Requisition[] {
  return listRequisitions()
}

export function listTeamTodos(): EquipmentTodo[] {
  return pendingTodos()
}

export function completeTeamTodo(id: number): ActionResult {
  return completeTodo(id)
    ? { ok: true, message: '装备待办已办理，已同步到队伍领用记录' }
    : { ok: false, message: '待办不存在或已办理，无需重复操作' }
}

export type TeamOption = {
  id: number
  code: string
  name: string
  farm: string
  status: string
}

export function teamOptions(onlyStandby = false): TeamOption[] {
  return listRows('fireteam')
    .filter((row) => !onlyStandby || !['已撤回', '休整中'].includes(String(row.status)))
    .map((row) => ({
      id: Number(row.id),
      code: String(row['队伍编号'] ?? ''),
      name: String(row['队伍名称'] ?? ''),
      farm: String(row['所属林场'] ?? ''),
      status: String(row.status),
    }))
}

function pickTeam(farm: string): TeamOption | undefined {
  const standby = teamOptions(true)
  return standby.find((team) => team.farm === farm) ?? standby[0]
}

function teamOf(teamId: number): TeamOption | undefined {
  return teamOptions().find((team) => team.id === Number(teamId))
}

// 列表展示用：动态建议、生效预警值（中位数兼容）、可用量、人工覆盖标记一次算好。
export type SupplyViewRow = {
  [field: string]: string | number | boolean | ReturnType<typeof evaluateSupply>
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  _eval: ReturnType<typeof evaluateSupply>
  _available: number
  _manualOverride: boolean
  _replenishing: boolean
}

export function buildSupplyViewRows(rows: EntryRow[]): SupplyViewRow[] {
  return rows.map((row) => {
    const evaluation = evaluateSupply(row, rows)
    const manual = String(row['盘点结论'] ?? '')
    const suggestion: string = evaluation.suggestion
    return {
      ...row,
      _eval: evaluation,
      _available: availableSupply(Number(row.id)),
      _manualOverride: manual !== '' && manual !== suggestion && suggestion !== '已过期',
      _replenishing: String(row['补货单号'] ?? '') !== '' && String(row['补货已确认'] ?? '否') !== '是',
    }
  })
}

export type StocktakeInput = {
  id: number
  actual: string
  manualConclusion: string
  operatorFarm: string
  operator: string
}

// 人工盘点：盘点结论以人工为准；与系统建议冲突时系统建议留痕并标记覆盖，库存只更新一次。
export function applyStocktake(input: StocktakeInput): SupplyMutation {
  const { rows, row, index } = findSupply(input.id)
  if (!row) {
    return fail('没有找到对应防火物资')
  }
  const farm = String(row[SUPPLY_FARM_FIELD] ?? '')
  if (farm !== input.operatorFarm) {
    return fail(`该物资由${farm}保管，当前林场只能查看，不能人工盘点`)
  }
  const checked = checkQuantity(input.actual, '盘点实际储备量')
  if (!checked.ok) {
    return fail(checked.message)
  }
  const before = toQuantity(row[SUPPLY_ACTUAL_FIELD])
  const beforeSuggest = supplySuggestion(row, rows)
  row[SUPPLY_ACTUAL_FIELD] = String(checked.value)
  const systemSuggest: string = supplySuggestion(row, rows)
  const manual = input.manualConclusion.trim()
  const conflict = manual !== '' && manual !== systemSuggest && systemSuggest !== '已过期'
  const effectiveStatus = systemSuggest === '已过期' ? '已过期' : manual || systemSuggest
  row.status = effectiveStatus
  row.pending = effectiveStatus !== '充足'
  row['盘点前建议'] = beforeSuggest
  row['盘点结论'] = effectiveStatus
  row['盘点备注'] = conflict
    ? `人工盘点（${input.operator}）判定「${effectiveStatus}」，覆盖系统建议「${systemSuggest}」，以人工为准`
    : `人工盘点（${input.operator}）确认数量，与系统建议一致`
  row['盘点时间'] = new Date().toISOString().slice(0, 10)
  rows[index] = row
  persistSupplies(rows)
  addStocktake({
    supplyId: Number(row.id),
    supplyCode: String(row['物资编号'] ?? ''),
    farm,
    operator: input.operator,
    beforeActual: before,
    afterActual: checked.value,
    systemSuggest,
    manualConclusion: effectiveStatus,
    conflict,
  })
  return {
    ok: true,
    message: conflict
      ? `盘点完成：人工结论「${effectiveStatus}」已覆盖系统建议「${systemSuggest}」（人工优先）`
      : `盘点完成：实际储备量更新为 ${checked.value}，与系统建议「${systemSuggest}」一致`,
  }
}

// 发起补充：登记补货单（不入库、不扣减），等待确认。
export function requestReplenish(id: number, operatorFarm: string): SupplyMutation {
  const { rows, row, index } = findSupply(id)
  if (!row) {
    return fail('没有找到对应防火物资')
  }
  const farm = String(row[SUPPLY_FARM_FIELD] ?? '')
  if (farm !== operatorFarm) {
    return fail(`该物资由${farm}保管，当前林场只能查看`)
  }
  if (String(row.status) === '已过期') {
    return fail('已过期物资不能发起补充，请先做报损处理')
  }
  if (String(row['补货单号'] ?? '') !== '' && String(row['补货已确认'] ?? '否') !== '是') {
    return fail(`补货单 ${row['补货单号']} 已发起待确认，请勿重复发起`)
  }
  const evaluation = evaluateSupply(row, rows)
  if (evaluation.gap <= 0) {
    return fail('实际储备量已达到预警/需求基准线，储备充足，无需补充')
  }
  const code = String(row['物资编号'] ?? `SUPP-${id}`)
  const orderNo = `BC-${code}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Number(row.id)}`
  row['补货单号'] = orderNo
  row['补货已确认'] = '否'
  row.status = '需补充'
  row.pending = true
  rows[index] = row
  persistSupplies(rows)
  return { ok: true, message: `已发起补货单 ${orderNo}，缺口 ${evaluation.gap} 件，确认后入库并联动扑火队伍装备待办` }
}

// 确认补充：补齐到基准线（只入库一次），同时向所属林场扑火队伍下发装备待办；重复提交幂等。
export function confirmReplenish(id: number, operatorFarm: string): SupplyMutation {
  const { rows, row, index } = findSupply(id)
  if (!row) {
    return fail('没有找到对应防火物资')
  }
  const farm = String(row[SUPPLY_FARM_FIELD] ?? '')
  if (farm !== operatorFarm) {
    return fail(`该物资由${farm}保管，当前林场只能查看`)
  }
  const orderNo = String(row['补货单号'] ?? '')
  if (!orderNo) {
    return fail('尚未发起补充，不能直接确认；请先发起补充')
  }
  if (String(row['补货已确认'] ?? '否') === '是') {
    return fail(`补货单 ${orderNo} 已确认入库，重复提交不会再次扣减/生成待办`)
  }
  const idemKey = `supply-replenish-${Number(row.id)}-${orderNo}`
  if (hasRequisition(`replenish-todo-${idemKey}`)) {
    row['补货已确认'] = '是'
    rows[index] = row
    persistSupplies(rows)
    return fail(`补货单 ${orderNo} 已处理过，已按幂等规则忽略重复提交`)
  }
  const beforeActual = toQuantity(row[SUPPLY_ACTUAL_FIELD])
  const evaluation = evaluateSupply(row, rows)
  const nextActual = beforeActual + evaluation.gap
  const checked = checkQuantity(nextActual, '入库后实际储备量')
  if (!checked.ok) {
    return fail(checked.message)
  }
  const team = pickTeam(farm)
  if (!team) {
    return fail('没有可承接装备的扑火队伍，无法联动待办，暂不允许确认补充')
  }
  row[SUPPLY_ACTUAL_FIELD] = String(nextActual)
  row['补货已确认'] = '是'
  applyQuantity(row, rows)
  row['补货单号'] = orderNo
  rows[index] = row
  persistSupplies(rows)
  const { todo } = addTodo({
    teamId: team.id,
    teamCode: team.code,
    teamName: team.name,
    supplyId: Number(row.id),
    supplyCode: String(row['物资编号'] ?? ''),
    supplyName: String(row['物资名称'] ?? ''),
    category: String(row[SUPPLY_CATEGORY_FIELD] ?? row[SUPPLY_CATEGORY_FIELD]),
    qty: evaluation.gap,
    reason: `物资确认补充到货 ${evaluation.gap} 件，需办理队伍装备配发`,
    sourceRef: orderNo,
    idemKey: `replenish-todo-${idemKey}`,
  })
  // 补货入库本身不是出库，只记录一条幂等标记，防止重复确认再次入库。
  addRequisition({
    entryType: '物资',
    refCode: orderNo,
    sourceModule: '物资确认补充',
    sourceRef: orderNo,
    farm,
    teamId: team.id,
    teamCode: team.code,
    teamName: team.name,
    itemId: Number(row.id),
    itemCode: String(row['物资编号'] ?? ''),
    itemName: String(row['物资名称'] ?? ''),
    category: String(row[SUPPLY_CATEGORY_FIELD] ?? ''),
    qty: 0,
    idemKey: `replenish-todo-${idemKey}`,
  })
  return {
    ok: true,
    todo,
    message: `补货单 ${orderNo} 已确认：入库 ${evaluation.gap} 件，实际储备量 ${nextActual}，已向「${team.name}」下发装备待办`,
  }
}

export type TransferInput = {
  supplyId: number
  teamId: number
  qty: string
  idemKey: string
  operatorFarm: string
}

// 人工调拨出库：校验可用量后扣减一次，写入队伍领用清单；同一提交键重复提交只扣一次。
export function transferSupply(input: TransferInput): SupplyMutation {
  if (hasRequisition(input.idemKey)) {
    return fail('该调拨单已提交过，已按幂等规则忽略，库存不会重复扣减')
  }
  const { rows, row, index } = findSupply(input.supplyId)
  if (!row) {
    return fail('没有找到对应防火物资')
  }
  const farm = String(row[SUPPLY_FARM_FIELD] ?? '')
  if (farm !== input.operatorFarm) {
    return fail(`该物资由${farm}保管，当前林场只能查看，不能调拨`)
  }
  if (String(row.status) === '已过期') {
    return fail('已过期物资禁止出库调拨')
  }
  const team = teamOf(input.teamId)
  if (!team) {
    return fail('请选择领用人所属扑火队伍')
  }
  const checked = checkQuantity(input.qty, '调拨数量')
  if (!checked.ok) {
    return fail(checked.message)
  }
  const available = availableSupply(input.supplyId)
  if (checked.value <= 0) {
    return fail('调拨数量必须大于 0')
  }
  if (checked.value > available) {
    return fail(`调拨数量 ${checked.value} 超过当前可用量 ${available}，不允许保存`)
  }
  const actual = toQuantity(row[SUPPLY_ACTUAL_FIELD])
  row[SUPPLY_ACTUAL_FIELD] = String(actual - checked.value)
  applyQuantity(row, rows)
  rows[index] = row
  persistSupplies(rows)
  const refCode = `DB-${String(row['物资编号'] ?? '')}-${team.code}`
  const { requisition } = addRequisition({
    entryType: '物资',
    refCode,
    sourceModule: '物资人工调拨',
    sourceRef: refCode,
    farm,
    teamId: team.id,
    teamCode: team.code,
    teamName: team.name,
    itemId: Number(row.id),
    itemCode: String(row['物资编号'] ?? ''),
    itemName: String(row['物资名称'] ?? ''),
    category: String(row[SUPPLY_CATEGORY_FIELD] ?? ''),
    qty: checked.value,
    idemKey: input.idemKey,
  })
  return {
    ok: true,
    requisition,
    message: `已向「${team.name}」调拨 ${checked.value} 件「${row['物资名称']}」，库存扣减一次，剩余可用量 ${availableSupply(input.supplyId)}`,
  }
}

// 火情处置调拨：火情「出动扑救」时按所属林场自动调拨物资给承接队伍，整张调拨单幂等。
export function dispatchFireReport(reportId: number): SupplyMutation {
  const reports = listRows('firereport')
  const reportIndex = reports.findIndex((item) => Number(item.id) === Number(reportId))
  if (reportIndex < 0) {
    return fail('没有找到对应火情报告')
  }
  const report = reports[reportIndex]
  const current = String(report.status)
  if (current !== '已确认') {
    return fail(`火情当前为「${current}」，仅「已确认」火情可出动扑救并调拨物资`)
  }
  const dispatchKey = `fire-dispatch-${Number(report.id)}`
  if (hasRequisition(dispatchKey)) {
    return fail('该火情已出动并生成调拨单，重复点击不会重复扣减物资')
  }
  const location = String(report['起火地点'] ?? '')
  const farm = teamOptions()
    .map((team) => team.farm)
    .find((name) => name && location.includes(name))
  if (!farm) {
    return fail('起火地点未匹配到林场，无法确定调拨来源，请在起火地点中注明林场')
  }
  const team = pickTeam(farm)
  if (!team) {
    return fail('没有可出动的扑火队伍，无法完成处置调拨')
  }
  const rows = supplyRows()
  const allocations: Requisition[] = []
  let totalQty = 0
  rows.forEach((row, index) => {
    if (String(row[SUPPLY_FARM_FIELD] ?? '') !== farm || String(row.status) === '已过期') {
      return
    }
    const available = Math.max(0, toQuantity(row[SUPPLY_ACTUAL_FIELD]) - issuedSupplyQty(Number(row.id)))
    if (available <= 0) {
      return
    }
    const baseline = evaluateSupply(row, rows).baseline
    const want = Math.min(available, Math.max(1, Math.ceil(baseline * 0.2)))
    if (want <= 0) {
      return
    }
    const actual = toQuantity(row[SUPPLY_ACTUAL_FIELD])
    row[SUPPLY_ACTUAL_FIELD] = String(actual - want)
    // 循环内已排除过期物资，这里直接按三档口径重算，避免误伤「已过期」状态。
    if (String(row.status) !== '已过期') {
      row.status = supplySuggestion(row, rows)
      row.pending = row.status !== '充足'
      row['盘点结论'] = ''
      row['盘点备注'] = ''
    }
    rows[index] = row
    totalQty += want
    const itemKey = `${dispatchKey}-supply-${Number(row.id)}`
    const { requisition } = addRequisition({
      entryType: '物资',
      refCode: String(report['报告编号'] ?? ''),
      sourceModule: '火情处置调拨',
      sourceRef: String(report['报告编号'] ?? ''),
      farm,
      teamId: team.id,
      teamCode: team.code,
      teamName: team.name,
      itemId: Number(row.id),
      itemCode: String(row['物资编号'] ?? ''),
      itemName: String(row['物资名称'] ?? ''),
      category: String(row[SUPPLY_CATEGORY_FIELD] ?? ''),
      qty: want,
      idemKey: itemKey,
    })
    allocations.push(requisition)
  })
  if (allocations.length === 0) {
    return fail(`${farm}没有可调拨的在库物资（可用量均为 0 或已过期），请先补充物资`)
  }
  persistSupplies(rows)
  report.status = '已出警'
  report.pending = true
  report['扑救情况'] = `已出动「${team.name}」处置，联动调拨 ${allocations.length} 类物资共 ${totalQty} 件`
  reports[reportIndex] = report
  saveRows('firereport', reports)
  return {
    ok: true,
    allocations,
    message: `已出动「${team.name}」并从${farm}调拨 ${allocations.length} 类物资共 ${totalQty} 件，重复提交只扣减一次`,
  }
}

export type EquipIssueInput = {
  equipmentId: number
  teamId: number
  operatorFarm: string
}

// 装备领用：单件装备只能出库一次，写入队伍领用清单（装备模块），重复领用只扣一次。
export function issueEquipment(input: EquipIssueInput): SupplyMutation {
  const rows = listRows('equipment')
  const index = rows.findIndex((item) => Number(item.id) === Number(input.equipmentId))
  if (index < 0) {
    return fail('没有找到对应消防装备')
  }
  const row = rows[index]
  const farm = String(row['保管林场'] ?? '')
  if (farm !== input.operatorFarm) {
    return fail(`该装备由${farm}保管，当前林场不能办理领用`)
  }
  if (String(row.status) !== '可用') {
    return fail(`装备当前为「${row.status}」，只有「可用」装备能办理领用`)
  }
  const team = teamOf(input.teamId)
  if (!team) {
    return fail('请选择领用扑火队伍')
  }
  const idemKey = `equip-issue-${Number(row.id)}`
  if (hasRequisition(idemKey)) {
    return fail('该装备已办理领用，重复出库只扣一次，已忽略本次提交')
  }
  row.status = '已领用'
  row.pending = true
  row['领用队伍'] = team.name
  rows[index] = row
  saveRows('equipment', rows)
  const { requisition } = addRequisition({
    entryType: '装备',
    refCode: String(row['装备编号'] ?? ''),
    sourceModule: '消防装备领用',
    sourceRef: String(row['装备编号'] ?? ''),
    farm,
    teamId: team.id,
    teamCode: team.code,
    teamName: team.name,
    itemId: Number(row.id),
    itemCode: String(row['装备编号'] ?? ''),
    itemName: String(row['装备名称'] ?? ''),
    category: String(row['装备类型'] ?? ''),
    qty: 1,
    idemKey,
  })
  return {
    ok: true,
    requisition,
    message: `装备「${row['装备名称']}」已由「${team.name}」领用，重复出库只扣一次`,
  }
}

// 队伍领用清单视图：合并物资调拨与装备领用，可用量随台账实时重算。
export type TeamRequisitionView = Requisition & { available: number }

export function buildTeamRequisitions(): TeamRequisitionView[] {
  return listRequisitions()
    .filter((item) => item.sourceModule !== '物资确认补充')
    .map((item) => ({
      ...item,
      available: item.entryType === '物资' ? availableSupply(item.itemId) : availableEquipment(item.itemId),
    }))
}

// 供规则列导出使用的常量透传。
export { SUPPLY_ACTUAL_FIELD, SUPPLY_WARN_FIELD, SUPPLY_DEMAND_FIELD, SUPPLY_CATEGORY_FIELD, SUPPLY_FARM_FIELD, listRequisitions }
