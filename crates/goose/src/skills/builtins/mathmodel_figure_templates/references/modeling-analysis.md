# 基础建模分析模板

完整版式优先查阅 [extended-chart-guide.md](extended-chart-guide.md)。以下两套补充分析模板与完整图版式并列保留。

| id | 图表 | 数据与计算 | 预览 |
| --- | --- | --- | --- |
| `pca-variance-report` | PCA 主成分与方差解释报告 | 样本×特征矩阵；中心化、标准化、SVD 与解释方差。 | [查看](../assets/previews/pca_variance_report_replica.webp) |
| `attribution-matrix-summary` | 特征贡献热图与汇总条形图 | 解析模型贡献与预测逐样本对齐；输入真实数据时传入真实解释值。 | [查看](../assets/previews/attribution_matrix_summary_replica.webp) |

这些模板均使用确定性演示数据；输出不能作为论文的实际实验结果。默认导出 PNG、PDF、SVG，不需要下载数据。
