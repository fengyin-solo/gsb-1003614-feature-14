/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 扑火队伍装备待办：物资确认补充（到货）后联动生成，队伍据此办理领用。
export type EquipmentTodo = {
  id: number
  teamId: number
  teamCode: string
  teamName: string
  supplyId: number
  supplyCode: string
  supplyName: string
  category: string
  qty: number
  reason: string
  sourceRef: string
  idemKey: string
  done: boolean
  createdAt: string
}

// 队伍领用（出库）台账：火情处置调拨、人工调拨、装备领用都落这里，库存扣减全部幂等。
export type Requisition = {
  id: number
  entryType: '物资' | '装备'
  refCode: string
  sourceModule: string
  sourceRef: string
  farm: string
  teamId: number
  teamCode: string
  teamName: string
  itemId: number
  itemCode: string
  itemName: string
  category: string
  qty: number
  idemKey: string
  createdAt: string
}

// 人工盘点留痕：记录盘点前后数量、系统建议与人工结论，冲突时以人工为准。
export type StocktakeRecord = {
  id: number
  supplyId: number
  supplyCode: string
  farm: string
  operator: string
  beforeActual: number
  afterActual: number
  systemSuggest: string
  manualConclusion: string
  conflict: boolean
  createdAt: string
}
