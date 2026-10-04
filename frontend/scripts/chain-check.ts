import { SEED_ROWS } from '../src/data/seed'
import { evaluateSupply, checkQuantity, categoryWarnMedian, SUPPLY_WARN_FIELD, SUPPLY_ACTUAL_FIELD } from '../src/data/supply-rule'
import { listRows } from '../src/data/local-store'
import {
  applyStocktake,
  requestReplenish,
  confirmReplenish,
  dispatchFireReport,
  transferSupply,
  issueEquipment,
  availableSupply,
  buildSupplyViewRows,
  buildTeamRequisitions,
} from '../src/api/supply-chain'
import { resetLedgers } from '../src/data/ledger-store'

let passed = 0
let failed = 0
function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

function supplyRow(id: number) {
  return listRows('supply').find((r) => Number(r.id) === id)!
}
function eqRow(id: number) {
  return listRows('equipment').find((r) => Number(r.id) === id)!
}

console.log('1) 统一阈值与数量校验')
assert('空值不允许保存', checkQuantity('').ok === false)
assert('负数不允许保存', checkQuantity('-1').ok === false)
assert('小数不允许保存', checkQuantity('1.5').ok === false)
assert('超过 9999 不允许保存', checkQuantity('10000').ok === false)
assert('边界 0 允许', checkQuantity('0').ok === true)
assert('边界 9999 允许', checkQuantity('9999').ok === true)

console.log('2) 三档动态判定（基准线=max(预警,需求)，100%/80%）')
assert('SUPP-0001 实际120≥基准100 → 充足', evaluateSupply(supplyRow(1), listRows('supply')).suggestion === '充足')
assert('SUPP-0002 26/30=86.7% → 偏低', evaluateSupply(supplyRow(2), listRows('supply')).suggestion === '偏低')
assert('SUPP-0003 30/100=30% → 需补充', evaluateSupply(supplyRow(3), listRows('supply')).suggestion === '需补充')

console.log('3) 历史缺少预警储备量按同类中位数兼容')
const drinking = supplyRow(7)
const eval7 = evaluateSupply(drinking, listRows('supply'))
const logisticsMedian = categoryWarnMedian(listRows('supply'), '后勤保障', 7)
assert('后勤保障类预警中位数=8（其余唯一有效值）', logisticsMedian === 8, `got ${logisticsMedian}`)
assert('SUPP-0007 走中位数兼容标记', eval7.warnFallback === true)
assert('SUPP-0007 生效预警=8，基准=max(8,500)=500，300/500=60% → 需补充', eval7.suggestion === '需补充')
assert('有预警值的物资不触发兼容', evaluateSupply(supplyRow(1), listRows('supply')).warnFallback === false)

console.log('4) 非保管林场只能查看')
const foreignStock = applyStocktake({ id: 1, actual: '100', manualConclusion: '', operatorFarm: '桦木林场', operator: '测试员' })
assert('非保管林场不能盘点他场物资', foreignStock.ok === false)
const foreignReq = requestReplenish(3, '桦木林场')
assert('非保管林场不能发起补充', foreignReq.ok === false)

console.log('5) 人工盘点与系统建议冲突 → 人工优先，系统留痕')
const beforeSuggest = evaluateSupply(supplyRow(2), listRows('supply')).suggestion
assert('盘点前系统建议为偏低', beforeSuggest === '偏低')
// 保持盘点数量 26（系统仍判偏低），人工下结论「充足」，构造冲突。
const stockResult = applyStocktake({ id: 2, actual: '26', manualConclusion: '充足', operatorFarm: '青松林场', operator: '测试员' })
assert('人工盘点保存成功', stockResult.ok === true)
const view2 = buildSupplyViewRows(listRows('supply')).find((r) => r.id === 2)!
assert('当前状态采用人工结论「充足」', String(view2.status) === '充足')
assert('行上标记人工覆盖', view2._manualOverride === true)
assert('系统建议仍为偏低并留痕', view2._eval.suggestion === '偏低')
// 无人工结论时盘点数量回到系统口径
applyStocktake({ id: 2, actual: '26', manualConclusion: '', operatorFarm: '青松林场', operator: '测试员' })
const view2b = buildSupplyViewRows(listRows('supply')).find((r) => r.id === 2)!
assert('撤掉人工结论后状态回归系统建议', String(view2b.status) === '偏低' && view2b._manualOverride === false)
const badQty = applyStocktake({ id: 2, actual: '12000', manualConclusion: '', operatorFarm: '青松林场', operator: '测试员' })
assert('盘点数量超范围不允许保存', badQty.ok === false)

console.log('6) 确认补充联动装备待办，重复提交只扣一次')
resetLedgers()
const req = requestReplenish(3, '青松林场')
assert('发起补充成功', req.ok === true, req.message)
const reqAgain = requestReplenish(3, '青松林场')
assert('重复发起被拦截', reqAgain.ok === false)
const actualBefore3 = Number(supplyRow(3)[SUPPLY_ACTUAL_FIELD])
const gap = evaluateSupply(supplyRow(3), listRows('supply')).gap
const confirm1 = confirmReplenish(3, '青松林场')
assert('确认补充成功并联动待办', confirm1.ok === true && !!confirm1.todo, confirm1.message)
const actualAfter1 = Number(supplyRow(3)[SUPPLY_ACTUAL_FIELD])
assert(`入库只补缺口（${actualBefore3}+${gap}=${actualAfter1}）`, actualAfter1 === actualBefore3 + gap)
assert('确认后状态回到充足', String(supplyRow(3).status) === '充足')
const todoCountAfter1 = buildTeamRequisitions().length // 不含补充标记(qty=0 且来源过滤)
const confirm2 = confirmReplenish(3, '青松林场')
assert('重复确认补充被幂等拦截', confirm2.ok === false, confirm2.message)
const actualAfter2 = Number(supplyRow(3)[SUPPLY_ACTUAL_FIELD])
assert('重复确认没有再次入库', actualAfter2 === actualAfter1)
assert('补充幂等标记不污染队伍领用清单', buildTeamRequisitions().length === todoCountAfter1)

console.log('7) 火情处置调拨：自动调拨、整单幂等、可用量重算')
const suppliesSnapshot = listRows('supply').map((r) => Number(r[SUPPLY_ACTUAL_FIELD]))
const dispatch1 = dispatchFireReport(2) // 云岭林场 已确认
assert('出动扑救成功并调拨', dispatch1.ok === true, dispatch1.message)
const allocated = (dispatch1.allocations ?? []).length
assert(`调拨了 ${allocated} 类物资`, allocated >= 1)
const requisitions1 = buildTeamRequisitions().filter((r) => r.sourceModule === '火情处置调拨').length
const dispatch2 = dispatchFireReport(2)
assert('重复出动扑救被幂等拦截', dispatch2.ok === false, dispatch2.message)
const requisitions2 = buildTeamRequisitions().filter((r) => r.sourceModule === '火情处置调拨').length
assert('重复调拨没有新增出库单', requisitions1 === requisitions2, `${requisitions1} vs ${requisitions2}`)
const snapshotAfter = listRows('supply').map((r) => Number(r[SUPPLY_ACTUAL_FIELD]))
const dispatch3 = dispatchFireReport(2)
const snapshotAfter2 = listRows('supply').map((r) => Number(r[SUPPLY_ACTUAL_FIELD]))
assert('重复调拨没有再次扣减库存', JSON.stringify(snapshotAfter) === JSON.stringify(snapshotAfter2))
assert('出库后有物资实际量下降', snapshotAfter.some((v, i) => v < suppliesSnapshot[i]))
assert('非已确认火情不能调拨', dispatchFireReport(1).ok === false)
const transferRows = buildTeamRequisitions()
assert('领用清单可用量字段已重算', transferRows.every((r) => typeof r.available === 'number' && r.available >= 0))

console.log('8) 人工调拨出库：超可用量拦截，重复提交只扣一次')
const targetId = 9 // 云岭林场 防护手套（未被火情调布动用，实际=可用=65）
const farmBefore = Number(supplyRow(targetId)[SUPPLY_ACTUAL_FIELD])
const key = 'manual-transfer-test-1'
const t1 = transferSupply({ supplyId: targetId, teamId: 2, qty: '10', idemKey: key, operatorFarm: '云岭林场' })
assert('人工调拨成功', t1.ok === true, t1.message)
assert('人工调拨扣减一次', Number(supplyRow(targetId)[SUPPLY_ACTUAL_FIELD]) === farmBefore - 10)
const t2 = transferSupply({ supplyId: targetId, teamId: 2, qty: '10', idemKey: key, operatorFarm: '云岭林场' })
assert('同一提交键重复调拨被拦截', t2.ok === false)
assert('重复调拨未再次扣减', Number(supplyRow(targetId)[SUPPLY_ACTUAL_FIELD]) === farmBefore - 10)
const over = transferSupply({ supplyId: targetId, teamId: 2, qty: String(farmBefore + 1), idemKey: 'manual-transfer-test-2', operatorFarm: '云岭林场' })
assert('调拨数量超可用量不允许保存', over.ok === false)
assert('可用量=实际-已出库', availableSupply(targetId) === Number(supplyRow(targetId)[SUPPLY_ACTUAL_FIELD]) - buildTeamRequisitions().filter((r) => r.entryType === '物资' && r.itemId === targetId).reduce((s, r) => s + r.qty, 0))

console.log('9) 装备领用：单件只扣一次，写入队伍领用清单（装备模块）')
const e1 = issueEquipment({ equipmentId: 1, teamId: 1, operatorFarm: '青松林场' })
assert('装备领用成功', e1.ok === true, e1.message)
assert('装备状态变为已领用', String(eqRow(1).status) === '已领用')
const e2 = issueEquipment({ equipmentId: 1, teamId: 1, operatorFarm: '青松林场' })
assert('重复领用被幂等拦截', e2.ok === false, e2.message)
assert('非可用装备不能领用', issueEquipment({ equipmentId: 4, teamId: 1, operatorFarm: '云岭林场' }).ok === false)
assert('他场保管装备不能领用', issueEquipment({ equipmentId: 2, teamId: 1, operatorFarm: '云岭林场' }).ok === false)
assert('队伍领用清单包含装备出库', buildTeamRequisitions().some((r) => r.entryType === '装备' && r.itemId === 1))

console.log('10) 过期物资不参与判定且禁止出库')
const expired = buildSupplyViewRows(listRows('supply')).find((r) => r.id === 10)!
assert('过期物资系统口径保持已过期', expired._eval.suggestion === '已过期')
assert('过期物资人工调拨被拦截', transferSupply({ supplyId: 10, teamId: 2, qty: '1', idemKey: 'expired-transfer', operatorFarm: '云岭林场' }).ok === false)

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exit(1)
void SEED_ROWS
