// C3：Office 导出的版本契约。实际渲染由服务端 tools/office-render/render.mjs 执行，
// 桌面端只引用版本常量与目标类型，不再在前端打包模板。
export const OFFICE_TEMPLATE_VERSION = 'office-render-v1'
export type OfficeKind = 'pptx' | 'docx'
