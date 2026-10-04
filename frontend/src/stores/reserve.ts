import { defineStore } from 'pinia'

import { listRows, saveRows, readMeta, writeMeta } from '@/data/local-store'
import {
  QUANTITY_MAX,
  REPLENISH_MAX,
  dispatchRecipeFor,
  evaluateSupply,
  inQuantityRange,
  parseQuantity,
  validateQuantityInput,
} from '@/data/supply-policy'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

export type LedgerKind = '调拨出库' | '队伍领用出库' | '补充入库' | '人工盘点'
export type LedgerSource = '火情处置' | '队伍领用' | '装备模块' | '应急演练' | '补充确认' | '人工盘点'

export type LedgerEntry = {
  id: number
  key: string
  time: string
  kind: LedgerKind
  source: LedgerSource
  farm: string
  supplyId: number
  supplyName: string
  category: string
  quantity: number
  ref: string
  operator: string
  /** 队伍领用出库时固定记录的领用队伍（与单据号 ref 区分，供领用清单聚合） */
  dedicatedTeam?: string
}

export type ReplenishRequest = {
  id: number
  supplyId: number
  quantity: number
  farm: string
  reason: string
  createdAt: string
  status: '待确认' | '已确认'
  confirmedAt?: string
  todoId?: number
}

export type EquipmentTodo = {
  id: number
  team: string
  teamId: number
  supplyId: number
  supplyName: string
  quantity: number
  farm: string
  source: string
  createdAt: string
  status: '待领用' | '已领用'
  ledgerId?: number
  claimedAt?: string
}

type ReserveMeta = {
  seq: { ledger: number; request: number; todo: number; supply: number }
  ledger: LedgerEntry[]
  requests: ReplenishRequest[]
  todos: EquipmentTodo[]
}

const META_KEY = 'forest-fire-patrol:reserve'

function emptyMeta(): ReserveMeta {
  return {
    seq: { ledger: 0, request: 0, todo: 0, supply: 0 },
    ledger: [],
    requests: [],
    todos: [],
  }
}

function nowLabel(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

export const useReserveStore = defineStore('reserve', {
  state: () => ({
    meta: emptyMeta() as ReserveMeta,
    loaded: false,
  }),
  getters: {
    supplyRows(): EntryRow[] {
      return listRows('supply')
    },
    ledger(): LedgerEntry[] {
      return [...this.meta.ledger].sort((a, b) => b.id - a.id)
    },
    replenishRequests(): ReplenishRequest[] {
      return [...this.meta.requests].sort((a, b) => b.id - a.id)
    },
    todos(): EquipmentTodo[] {
      return [...this.meta.todos].sort((a, b) => b.id - a.id)
    },
    /** 队伍领用清单：按队伍 + 物资汇总已出库数量，并实时重算物资可用量 */
    teamIssueList(): {
      team: string
      supplyId: number
      supplyName: string
      category: string
      farm: string
      issued: number
      available: number
      actual: number
    }[] {
      const rows = listRows('supply')
      const actualOf = new Map(rows.map((row) => [Number(row.id), parseQuantity(row['实际储备量']) ?? 0]))
      const map = new Map<string, { team: string; supplyId: number; supplyName: string; category: string; farm: string; issued: number }>()
      for (const entry of this.meta.ledger) {
        if (entry.kind !== '队伍领用出库') {
          continue
        }
        // 领用清单按「队伍」聚合：待办领取等场景的 ref 是单据号，队伍名固定挂在 dedicatedTeam 上
        const team = String(entry.dedicatedTeam ?? '')
        const key = `${team}@@${entry.supplyId}`
        const prev = map.get(key)
        if (prev) {
          prev.issued += Math.abs(entry.quantity)
        } else {
          map.set(key, {
            team,
            supplyId: entry.supplyId,
            supplyName: entry.supplyName,
            category: entry.category,
            farm: entry.farm,
            issued: Math.abs(entry.quantity),
          })
        }
      }
      return [...map.values()].map((item) => {
        const actual = actualOf.get(item.supplyId) ?? 0
        // 可用量 = 当前实际储备（已含历次出库扣减）；累计领用随台账实时汇总
        return { ...item, actual, available: Math.max(actual, 0) }
      })
    },
    pendingTodos(): EquipmentTodo[] {
      return this.todos.filter((todo) => todo.status === '待领用')
    },
  },
  actions: {
    init() {
      if (this.loaded) {
        return
      }
      this.meta = { ...emptyMeta(), ...(readMeta(META_KEY) as Partial<ReserveMeta>) }
      // 历史数据首次装载：按统一口径重算一次状态（缺失预警量按同类中位数兼容）
      this.resyncAll()
      this.loaded = true
    },
    persist() {
      writeMeta(META_KEY, this.meta)
    },
    requireKeeper(farm: string): string | null {
      const session = useSessionStore()
      if (!session.isKeeperOf(farm)) {
        return `当前身份为${session.currentFarm}，非该物资保管林场（${farm}），只能查看`
      }
      return null
    },
    findSupply(id: number): EntryRow | undefined {
      return listRows('supply').find((row) => Number(row.id) === id)
    },
    evaluation(row: EntryRow) {
      return evaluateSupply(row, listRows('supply'))
    },
    updateSupply(id: number, patch: Partial<EntryRow>): void {
      const rows = listRows('supply')
      const next: EntryRow[] = rows.map((row) =>
        Number(row.id) === id ? ({ ...row, ...patch } as EntryRow) : row,
      )
      saveRows('supply', next)
    },
    /** 按动态储备口径重算单条物资状态与建议 */
    resyncRow(row: EntryRow): EntryRow {
      const result = evaluateSupply(row, listRows('supply'))
      return {
        ...row,
        status: result.status,
        pending: result.status !== '充足' && result.status !== '已过期',
        abnormal: result.status === '需补充' || result.status === '已过期',
      }
    },
    resyncAll() {
      const rows = listRows('supply')
      const next: EntryRow[] = rows.map((row) => this.resyncRow(row))
      saveRows('supply', next)
    },
    hasLedgerKey(key: string): boolean {
      return this.meta.ledger.some((entry) => entry.key === key)
    },
    appendLedger(part: Omit<LedgerEntry, 'id' | 'time' | 'operator'> & { key: string }): LedgerEntry {
      const session = useSessionStore()
      const entry: LedgerEntry = {
        ...part,
        id: ++this.meta.seq.ledger,
        time: nowLabel(),
        operator: session.operator,
      }
      this.meta.ledger.push(entry)
      return entry
    },

    /**
     * 人工盘点（盘点优先裁决）：以现场实盘数覆盖实际储备量，系统不锁状态，
     * 随后按统一口径重算建议；盘点人与差异写台账，系统建议不回改盘点数。
     */
    stocktake(id: number, counted: number, note: string): { ok: boolean; message: string } {
      const row = this.findSupply(id)
      if (!row) {
        return { ok: false, message: '没有找到该物资' }
      }
      const denied = this.requireKeeper(String(row['储备林场']))
      if (denied) {
        return { ok: false, message: denied }
      }
      if (!inQuantityRange(counted)) {
        return { ok: false, message: `实盘数量必须是 0~${QUANTITY_MAX} 的整数，超出范围不允许保存` }
      }
      const before = parseQuantity(row['实际储备量']) ?? 0
      const key = `盘点:${id}:${before}:${counted}:${this.meta.ledger.length}`
      this.updateSupply(id, {
        实际储备量: counted,
        盘点时间: nowLabel(),
        盘点人: useSessionStore().operator,
        盘点差异: counted - before,
        盘点备注: note || '人工盘点优先于系统建议',
      })
      this.appendLedger({
        key,
        kind: '人工盘点',
        source: '人工盘点',
        farm: String(row['储备林场']),
        supplyId: id,
        supplyName: String(row['物资名称']),
        category: String(row['物资类别']),
        quantity: counted - before,
        ref: `盘点#${this.meta.seq.ledger + 1}`,
      })
      this.resyncAll()
      this.persist()
      return { ok: true, message: `盘点已保存（人工盘点优先），实际储备量更新为 ${counted}，系统已按口径重算建议` }
    },

    /** 登记新物资：数量域统一校验，越界不允许保存 */
    registerSupply(input: {
      name: string
      category: string
      spec: string
      warning: number | null
      actual: number
      demand: number | null
    }): { ok: boolean; message: string; id?: number } {
      const session = useSessionStore()
      if (!input.name.trim() || !input.category.trim()) {
        return { ok: false, message: '物资名称与物资类别不能为空' }
      }
      const error = validateQuantityInput(input)
      if (error) {
        return { ok: false, message: `${error}，超出范围不允许保存` }
      }
      const rows = listRows('supply')
      const id = Math.max(this.meta.seq.supply, ...rows.map((row) => Number(row.id))) + 1
      this.meta.seq.supply = id
      const created: EntryRow = {
        id,
        status: '充足',
        pending: true,
        abnormal: false,
        物资编号: `SUPP-${String(id).padStart(4, '0')}`,
        物资名称: input.name.trim(),
        物资类别: input.category.trim(),
        规格型号: input.spec.trim() || '—',
        储备林场: session.currentFarm,
        预警储备量: input.warning ?? '',
        林场需求量: input.demand ?? '',
        实际储备量: input.actual,
      }
      saveRows('supply', [...rows, created])
      this.resyncAll()
      this.persist()
      return { ok: true, message: '物资已登记，状态与建议已按统一口径计算', id }
    },

    /** 发起补充：只对偏低/需补充的物资开放，生成待确认申请 */
    requestReplenish(id: number, quantity: number): { ok: boolean; message: string; requestId?: number } {
      const row = this.findSupply(id)
      if (!row) {
        return { ok: false, message: '没有找到该物资' }
      }
      const denied = this.requireKeeper(String(row['储备林场']))
      if (denied) {
        return { ok: false, message: denied }
      }
      const evaluation = evaluateSupply(row, listRows('supply'))
      if (evaluation.status === '已过期') {
        return { ok: false, message: '已过期物资不能补充，请先处置过期库存' }
      }
      if (evaluation.gap <= 0) {
        return { ok: false, message: '实际储备已满足动态基线，无需发起补充' }
      }
      if (!inQuantityRange(quantity, REPLENISH_MAX) || quantity <= 0) {
        return { ok: false, message: `补充数量必须是 1~${REPLENISH_MAX} 的整数，超出范围不允许保存` }
      }
      const duplicate = this.meta.requests.find(
        (request) => request.supplyId === id && request.status === '待确认' && request.quantity === quantity,
      )
      if (duplicate) {
        return { ok: false, message: `相同数量的补充申请 #${duplicate.id} 已存在，请勿重复提交` }
      }
      const request: ReplenishRequest = {
        id: ++this.meta.seq.request,
        supplyId: id,
        quantity,
        farm: String(row['储备林场']),
        reason: evaluation.advice,
        createdAt: nowLabel(),
        status: '待确认',
      }
      this.meta.requests.push(request)
      this.persist()
      return { ok: true, message: `补充申请 #${request.id} 已发起，等待确认`, requestId: request.id }
    },

    /**
     * 确认补充：实际储备量入库 + 联动生成扑火队伍装备待办。
     * 幂等：同一申请重复确认只入库一次，待办也只生成一份。
     */
    confirmReplenish(requestId: number, teamId: number): { ok: boolean; message: string } {
      const request = this.meta.requests.find((item) => item.id === requestId)
      if (!request) {
        return { ok: false, message: `没有找到补充申请 #${requestId}` }
      }
      // 重复提交只扣减（入库）一次
      if (request.status === '已确认') {
        return { ok: false, message: `补充申请 #${requestId} 已确认入库，重复提交不会再次扣减或生成待办` }
      }
      const row = this.findSupply(request.supplyId)
      if (!row) {
        return { ok: false, message: '关联物资已不存在' }
      }
      const denied = this.requireKeeper(request.farm)
      if (denied) {
        return { ok: false, message: denied }
      }
      const team = listRows('fireteam').find((item) => Number(item.id) === teamId)
      if (!team) {
        return { ok: false, message: '请选择接收装备的扑火队伍' }
      }
      const ledgerKey = `补充入库:申请#${requestId}`
      if (this.hasLedgerKey(ledgerKey)) {
        request.status = '已确认'
        this.persist()
        return { ok: false, message: '该笔补充已入库，系统已拦截重复提交' }
      }
      const before = parseQuantity(row['实际储备量']) ?? 0
      const nextActual = before + request.quantity
      if (!inQuantityRange(nextActual)) {
        return { ok: false, message: `入库后总量 ${nextActual} 超出上限 ${QUANTITY_MAX}，不允许保存` }
      }
      this.updateSupply(request.supplyId, { 实际储备量: nextActual })
      const ledger = this.appendLedger({
        key: ledgerKey,
        kind: '补充入库',
        source: '补充确认',
        farm: request.farm,
        supplyId: request.supplyId,
        supplyName: String(row['物资名称']),
        category: String(row['物资类别']),
        quantity: request.quantity,
        ref: `补充申请#${requestId}`,
      })
      const todo: EquipmentTodo = {
        id: ++this.meta.seq.todo,
        team: String(team['队伍名称']),
        teamId,
        supplyId: request.supplyId,
        supplyName: String(row['物资名称']),
        quantity: request.quantity,
        farm: request.farm,
        source: `补充申请#${requestId}`,
        createdAt: nowLabel(),
        status: '待领用',
      }
      this.meta.todos.push(todo)
      request.status = '已确认'
      request.confirmedAt = nowLabel()
      request.todoId = todo.id
      this.resyncAll()
      this.persist()
      return {
        ok: true,
        message: `补充已确认：入库 ${request.quantity}（台账#${ledger.id}），并已联动生成队伍「${todo.team}」装备待办 #${todo.id}`,
      }
    },

    /** 队伍领取装备待办：出库扣减一次，同一待办重复领取被拦截 */
    claimTodo(todoId: number): { ok: boolean; message: string } {
      const todo = this.meta.todos.find((item) => item.id === todoId)
      if (!todo) {
        return { ok: false, message: `没有找到装备待办 #${todoId}` }
      }
      const denied = this.requireKeeper(todo.farm)
      if (denied) {
        return { ok: false, message: denied }
      }
      if (todo.status === '已领用') {
        return { ok: false, message: `待办 #${todoId} 已出库（台账#${todo.ledgerId}），重复出库只扣一次` }
      }
      const key = `队伍领用出库:待办#${todoId}`
      const result = this.issueOutbound({
        key,
        source: '队伍领用',
        team: todo.team,
        supplyId: todo.supplyId,
        quantity: todo.quantity,
        ref: `待办#${todoId}`,
      })
      if (!result.ok) {
        return result
      }
      todo.status = '已领用'
      todo.claimedAt = nowLabel()
      todo.ledgerId = result.ledgerId
      this.resyncAll()
      this.persist()
      return { ok: true, message: `待办 #${todoId} 已出库扣减 ${todo.quantity}，队伍领用清单已重算可用量` }
    },

    /**
     * 队伍领用出库（装备模块、应急演练、队伍页等共用）：
     * 数量与可用量统一校验，幂等键保证重复出库只扣一次。
     */
    issueOutbound(input: {
      key: string
      source: LedgerSource
      team: string
      supplyId: number
      quantity: number
      ref: string
    }): { ok: boolean; message: string; ledgerId?: number } {
      if (this.hasLedgerKey(input.key)) {
        return { ok: false, message: '该笔出库已处理过，重复出库只扣减一次' }
      }
      if (!input.team.trim()) {
        return { ok: false, message: '请选择领用队伍' }
      }
      const row = this.findSupply(input.supplyId)
      if (!row) {
        return { ok: false, message: '没有找到该物资' }
      }
      const denied = this.requireKeeper(String(row['储备林场']))
      if (denied) {
        return { ok: false, message: denied }
      }
      if (!inQuantityRange(input.quantity, REPLENISH_MAX) || input.quantity <= 0) {
        return { ok: false, message: `出库数量必须是 1~${REPLENISH_MAX} 的整数，超出范围不允许保存` }
      }
      const before = parseQuantity(row['实际储备量']) ?? 0
      if (String(row.status) === '已过期' || row['已过期'] === true) {
        return { ok: false, message: '已过期物资不允许出库' }
      }
      if (input.quantity > before) {
        return { ok: false, message: `出库数量 ${input.quantity} 超过实际储备量 ${before}，不允许保存` }
      }
      this.updateSupply(input.supplyId, { 实际储备量: before - input.quantity })
      const ledger = this.appendLedger({
        key: input.key,
        kind: '队伍领用出库',
        source: input.source,
        farm: String(row['储备林场']),
        supplyId: input.supplyId,
        supplyName: String(row['物资名称']),
        category: String(row['物资类别']),
        quantity: -input.quantity,
        ref: input.ref,
        dedicatedTeam: input.team,
      })
      this.resyncAll()
      this.persist()
      return { ok: true, message: `已向「${input.team}」出库 ${input.quantity} 件，实际储备扣减，各模块领用清单同步重算`, ledgerId: ledger.id }
    },

    /**
     * 火情处置调拨：火情报告「出动扑救」时按火势等级配方一次性扣减保管林场的物资。
     * 同一火情重复出动只扣一次；库存不足整笔不保存。
     */
    dispatchFire(input: {
      fireId: number
      level: string
      farm: string
      reportNo: string
    }): { ok: boolean; message: string; lines?: { name: string; quantity: number; short: number }[] } {
      const denied = this.requireKeeper(input.farm)
      if (denied) {
        return { ok: false, message: denied }
      }
      const key = `火情调拨:${input.fireId}`
      if (this.hasLedgerKey(key)) {
        return { ok: false, message: `火情 ${input.reportNo} 的调拨已执行过，重复出动只扣减一次` }
      }
      const rows = listRows('supply').filter((row) => String(row['储备林场']) === input.farm)
      const recipe = dispatchRecipeFor(input.level)
      const lines: { name: string; quantity: number; short: number }[] = []
      // 先整单校验：任一物资不足则整笔不保存
      for (const [name, quantity] of Object.entries(recipe)) {
        const candidates = rows
          .filter((row) => String(row['物资名称']) === name && row.status !== '已过期')
          .sort((a, b) => (parseQuantity(a['实际储备量']) ?? 0) - (parseQuantity(b['实际储备量']) ?? 0))
        let remain = quantity
        for (const row of candidates) {
          remain -= Math.min(remain, parseQuantity(row['实际储备量']) ?? 0)
        }
        lines.push({ name, quantity, short: remain })
      }
      const shortage = lines.filter((line) => line.short > 0)
      if (shortage.length) {
        return {
          ok: false,
          message: `库存不足，整笔调拨未保存：${shortage.map((line) => `${line.name}缺${line.short}`).join('、')}`,
          lines,
        }
      }
      // 逐物资扣减（同名多批次依次占用）
      for (const [name, quantity] of Object.entries(recipe)) {
        let remain = quantity
        for (const row of rows) {
          if (remain <= 0) {
            break
          }
          if (String(row['物资名称']) !== name || row.status === '已过期') {
            continue
          }
          const stock = parseQuantity(row['实际储备量']) ?? 0
          if (stock <= 0) {
            continue
          }
          const used = Math.min(stock, remain)
          remain -= used
          this.updateSupply(Number(row.id), { 实际储备量: stock - used })
          this.appendLedger({
            key: `${key}:${row.id}`,
            kind: '调拨出库',
            source: '火情处置',
            farm: input.farm,
            supplyId: Number(row.id),
            supplyName: name,
            category: String(row['物资类别']),
            quantity: -used,
            ref: `火情${input.reportNo}`,
          })
        }
      }
      // 幂等哨兵，保证同一火情再次出动被拦截
      this.appendLedger({
        key,
        kind: '调拨出库',
        source: '火情处置',
        farm: input.farm,
        supplyId: -1,
        supplyName: '—',
        category: '—',
        quantity: 0,
        ref: `火情${input.reportNo}`,
      })
      this.resyncAll()
      this.persist()
      return { ok: true, message: `火情 ${input.reportNo} 调拨完成，已按「${input.level}」配方扣减，物资状态与领用清单已重算`, lines }
    },

    markExpired(id: number): { ok: boolean; message: string } {
      const row = this.findSupply(id)
      if (!row) {
        return { ok: false, message: '没有找到该物资' }
      }
      const denied = this.requireKeeper(String(row['储备林场']))
      if (denied) {
        return { ok: false, message: denied }
      }
      this.updateSupply(id, { status: '已过期', 已过期: true })
      this.resyncAll()
      this.persist()
      return { ok: true, message: '物资已标记过期，已退出动态储备口径' }
    },
  },
})
