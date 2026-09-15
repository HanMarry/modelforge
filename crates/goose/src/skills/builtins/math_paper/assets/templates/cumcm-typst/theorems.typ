// 定理环境（thmbox）的本地实现。
//
// 原模板从 `@preview/ctheorems:1.1.3` 导入这个函数，但那会让模板**必须联网**
// 才能编译（首次编译时 Typst 要去 packages.typst.org 下载包）。比赛现场或受限网络
// 下整篇论文都编译不出来，因此改为本地等价实现。
//
// 接口：
//   thmbox(name)                               -> 环境函数，接内容
//   thmbox.with(inset: .., breakable: ..)      -> 预设版式后仍按 (name) 使用
//   环境函数.with(numbering: "1")               -> 设定编号形式
//
// lib.typ 中的调用：
//   #let envbox = thmbox.with(inset: 0pt, breakable: true, padding: (..))
//   #let definition = envbox("definition", "定义").with(numbering: "1")
//   #definition[内容]
//
// 因此 `thmbox` 接收显示名 `name`，返回一个接收 `body` 的柯里化函数，
// `.with(numbering:)` 作用在这最后一层。
//
// 说明：ctheorems 为 MIT 许可。此处是按所需接口重写的实现，未复制其源码。

#let thm-counter = counter("modelforge-thm")

#let thmbox(
  name,
  inset: 0pt,
  breakable: true,
  padding: (top: 0em, bottom: 0em),
) = (
  numbering: none,
  body,
) => {
  let label = if numbering == none {
    if name == none { [] } else { text(weight: "bold")[#name.] }
  } else {
    thm-counter.step()
    context {
      let n = thm-counter.display(numbering)
      if name == none { text(weight: "bold")[#n.] }
      else { text(weight: "bold")[#name #n.] }
    }
  }

  block(
    breakable: breakable,
    inset: inset,
    above: padding.top,
    below: padding.bottom,
    {
      label
      body
    },
  )
}
