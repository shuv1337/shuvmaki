// Cross-request maps used by the SDK fetch adapter and the SSE translator.
// permission.reply and question.reply omit session IDs, so we remember them
// from the earlier asked/created events.

export type RememberedFormField = {
  key: string
  type: string
}

const permissionSessionByRequestId = new Map<string, string>()
const formById = new Map<
  string,
  {
    sessionID: string
    fields: RememberedFormField[]
  }
>()

export function rememberShuvcodePermissionRequest({
  requestID,
  sessionID,
}: {
  requestID: string
  sessionID: string
}): void {
  permissionSessionByRequestId.set(requestID, sessionID)
}

export function lookupShuvcodePermissionSession(requestID: string) {
  return permissionSessionByRequestId.get(requestID)
}

export function forgetShuvcodePermissionRequest(requestID: string): void {
  permissionSessionByRequestId.delete(requestID)
}

export function rememberShuvcodeForm({
  formID,
  sessionID,
  fields,
}: {
  formID: string
  sessionID: string
  fields: RememberedFormField[]
}): void {
  formById.set(formID, { sessionID, fields })
}

export function lookupShuvcodeForm(formID: string) {
  return formById.get(formID)
}

export function forgetShuvcodeForm(formID: string): void {
  formById.delete(formID)
}

export function resetShuvcodeAdapterState(): void {
  permissionSessionByRequestId.clear()
  formById.clear()
}
