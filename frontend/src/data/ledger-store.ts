import type { EquipmentTodo, Requisition, StocktakeRecord } from './types'

// 独立于业务登记的「联动台账」：扑火队伍装备待办、队伍领用（出库）单、人工盘点留痕都放这里。
// 与业务表分开存，保证物资/装备状态变更与跨模块调用链可以幂等地互相联动。
const STORAGE_KEY = 'forest-fire-patrol:ledgers'

type LedgerState = {
  todos: EquipmentTodo[]
  requisitions: Requisition[]
  stocktakes: StocktakeRecord[]
  seq: number
}

export const LEDGER_VERSION_KEY = 'forest-fire-patrol:ledgers-version'

function emptyState(): LedgerState {
  return { todos: [], requisitions: [], stocktakes: [], seq: 1 }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readState(): LedgerState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return emptyState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return emptyState()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LedgerState>
    return {
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
      requisitions: Array.isArray(parsed.requisitions) ? parsed.requisitions : [],
      stocktakes: Array.isArray(parsed.stocktakes) ? parsed.stocktakes : [],
      seq: typeof parsed.seq === 'number' ? parsed.seq : 1,
    }
  } catch {
    return emptyState()
  }
}

let cache: LedgerState | null = null

function state(): LedgerState {
  if (cache === null) {
    cache = readState()
  }
  return cache
}

// 变更后自增版本号，页面即使常驻同一视图也能监听到跨模块改动并重算可用量。
function persist(): void {
  const next = state()
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    window.localStorage.setItem(LEDGER_VERSION_KEY, String(Date.now()))
    window.dispatchEvent(new Event('forest-ledger-changed'))
  }
}

export function resetLedgers(): LedgerState {
  cache = emptyState()
  persist()
  return clone(state())
}

function nextId(): number {
  const next = state()
  next.seq += 1
  return next.seq
}

// 幂等键：重复提交（同一份补货/调拨/出库）只落一条、只扣减一次。
function findByKey(collection: { idemKey: string }[], idemKey: string): boolean {
  return collection.some((item) => item.idemKey === idemKey)
}

export function listTodos(): EquipmentTodo[] {
  return clone(state().todos)
}

export function pendingTodos(teamId?: number): EquipmentTodo[] {
  const rows = state().todos.filter((item) => !item.done)
  const filtered = teamId === undefined ? rows : rows.filter((item) => item.teamId === teamId)
  return clone(filtered)
}

// 返回值标识是否新增；命中幂等键直接返回已有待办，不再重复生成、不重复扣减。
export function addTodo(todo: Omit<EquipmentTodo, 'id' | 'done' | 'createdAt'> & { idemKey: string }): { created: boolean; todo: EquipmentTodo } {
  const all = state().todos
  const existing = all.find((item) => item.idemKey === todo.idemKey)
  if (existing) {
    return { created: false, todo: clone(existing) }
  }
  const created: EquipmentTodo = {
    ...todo,
    id: nextId(),
    done: false,
    createdAt: new Date().toISOString().slice(0, 10),
  }
  all.push(created)
  persist()
  return { created: true, todo: clone(created) }
}

export function completeTodo(id: number): boolean {
  const target = state().todos.find((item) => item.id === id)
  if (!target || target.done) {
    return false
  }
  target.done = true
  persist()
  return true
}

export function listRequisitions(): Requisition[] {
  return clone(state().requisitions)
}

export function hasRequisition(idemKey: string): boolean {
  return findByKey(state().requisitions, idemKey)
}

export function addRequisition(
  record: Omit<Requisition, 'id' | 'createdAt'>,
): { created: boolean; requisition: Requisition } {
  const all = state().requisitions
  const existing = all.find((item) => item.idemKey === record.idemKey)
  if (existing) {
    return { created: false, requisition: clone(existing) }
  }
  const created: Requisition = {
    ...record,
    id: nextId(),
    createdAt: new Date().toISOString().slice(0, 10),
  }
  all.push(created)
  persist()
  return { created: true, requisition: clone(created) }
}

export function listStocktakes(): StocktakeRecord[] {
  return clone(state().stocktakes)
}

export function addStocktake(
  record: Omit<StocktakeRecord, 'id' | 'createdAt'>,
): StocktakeRecord {
  const created: StocktakeRecord = {
    ...record,
    id: nextId(),
    createdAt: new Date().toISOString().slice(0, 10),
  }
  state().stocktakes.unshift(created)
  persist()
  return clone(created)
}
