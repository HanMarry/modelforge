# 完整科研图版式目录

本目录包含 59 种筛选后的完整图形版式，每套对应独立脚本与预览。默认保留全部面板、子图顺序、边缘分布、图中图、图例、色标和坐标尺度。不能自动缩成单幅示意图，也不能用同类基础图代替复合版式。

运行任意 id 或完整中文图名即可生成整套 PNG、PDF、SVG。所有脚本仅依赖 NumPy、Matplotlib、SciPy，可独立复制运行。默认使用确定性演示数据；替换真实数据时修改复制到工作区的脚本，并重新计算图中统计量。

编号沿用上一版预览，删除后保留空号；PDF 页码不等于模板编号。

## 输入与计算说明

- **排序和相关图**：输入对齐的样本 × 变量矩阵。PCoA、RDA、相关系数及图中 p 值从示例样本计算；相关不等于因果。只有明确标注 FDR 的图应用多重检验校正。
- **分布图**：输入分组原始观测，小提琴为 KDE，箱体为四分位距和中位数。两组秩检验使用双侧 Mann–Whitney U；六面板小提琴默认仅展示分布，不声称完成多重比较。
- **组成、排名和环形图**：示例值直接生成以展示结构。百分比按组成归一化。环形多指标图逐层颜色与外围总量为不同编码，不能把外圈柱理解成所有指标的简单求和。
- **回归和预测图**：拟合和误差指标按当前演示点计算。真实使用需传入训练流程导出的观测和预测结果。
- **特征贡献图**：使用独立变量的解析加性模型或显式双线性交互示例，图中的 SHAP 表述仅适用于该解析示例。真实模型必须传入对应的解释值、背景基准和输出单位，不能只更换模型名。贡献区间是固定模型下样本绝对贡献均值的 t 区间，不是重训区间。
- **平滑效应图**：二维等值面使用解析演示函数；散点平滑使用多项式拟合，阴影为均值响应的近似 95% 区间。描述性的零交点不等于因果阈值。
- **空间图**：使用合成网格，类别图按示例评分取最大类别；没有真实地理坐标。偏相关栅格逐格对时间序列残差化计算，不是空间邻域检验。接入真实栅格时必须保持投影、分辨率、样本轴与掩膜一致。
- **时间图**：库存由功率累计计算；替换真实数据时必须统一时间步长、功率和能量单位。

## 排序与多变量分析

| 原编号 | id / 图表 | 完整版式 | 输入补充 | 预览 |
| --- | --- | --- | --- | --- |
| 01 | `pca-association-network`<br>三角相关矩阵与主成分连线图 | 三角方块相关矩阵与四个主成分节点在同一画布连接；左侧色标及线宽图例 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/pca_association_network_replica.webp) |
| 02 | `clustered-rank-correlation`<br>双向层次聚类相关热图 | 24×14矩形秩相关热图；独立行列聚类树、显著性标记、变量标签和色标 | 行列分别聚类，矩形相关块不要求相同变量集合。 | [查看](../assets/previews/clustered_rank_correlation_replica.webp) |
| 03 | `principal-coordinate-map`<br>主坐标排序与边缘密度图 | 中央排序散点与椭圆；顶部和右侧平滑密度；图内分组图例 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/principal_coordinate_map_replica.webp) |
| 04 | `redundancy-ordination`<br>多编码约束排序图 | 单排序面板；10支变量箭头；颜色、形状、大小三组独立图例 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/redundancy_ordination_replica.webp) |

## 组成、排名与多层报告

| 原编号 | id / 图表 | 完整版式 | 输入补充 | 预览 |
| --- | --- | --- | --- | --- |
| 05 | `circular-ranking-bars`<br>同心圆弧排名图 | 九条同心圆弧；起点类别、弧内数值与外围角度刻度 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/circular_ranking_bars_replica.webp) |
| 06 | `ternary-composition`<br>三元组成与连续变量气泡图 | 三角网格与三轴刻度；点颜色与大小双编码；独立色标和大小图例 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/ternary_composition_replica.webp) |
| 10 | `horizontal-share-bars`<br>横向组成比例与连接带图 | 六条横向百分比堆叠；分区数值、行间连接带和右侧图例 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/horizontal_share_bars_replica.webp) |
| 13 | `polar-area-panels`<br>九宫格径向扇区分布图 | 3×3九个径向扇区面板；每图14类、百分比外标和逐图色阶图例 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/polar_area_panels_replica.webp) |
| 15 | `radial-stacked-sectors`<br>多对象径向堆叠柱图 | 22对象径向堆叠柱；22组成分量、外侧标签、径向刻度与完整颜色图例 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/radial_stacked_sectors_replica.webp) |
| 16 | `ranked-feature-heatmap`<br>排名柱形与贡献热图联合报告 | 上方18项排名柱图与环图；13×18矩阵及右侧两列汇总数值 | 顶部重要性为演示摘要，右侧两列比例逐行合计为 100%。 | [查看](../assets/previews/ranked_feature_heatmap_replica.webp) |

## 三维与同心环形图

| 原编号 | id / 图表 | 完整版式 | 输入补充 | 预览 |
| --- | --- | --- | --- | --- |
| 17 | `ribbon-trajectories-3d`<br>多组年度三维条带图 | 八组逐年有宽度的三维折线条带；三维网格、组名及内置颜色图例 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/ribbon_trajectories_3d_replica.webp) |
| 18 | `waterfall-density-3d`<br>多组多阶段三维瀑布峰图 | 四组配色、每组三阶段共12条瀑布峰；透明填充、阶段标注和图例 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/waterfall_density_3d_replica.webp) |
| 19 | `layered-heatmaps-3d`<br>四层三维矩阵热图 | 四层独立热图平面；三维透视、层级标签和共享色标 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/layered_heatmaps_3d_replica.webp) |
| 20 | `column-grid-3d`<br>规则矩阵三维柱图 | 10×10三维柱阵；高度与颜色双编码、三轴刻度和独立色标 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/column_grid_3d_replica.webp) |
| 21 | `radial-cohort-dashboard`<br>多队列密集环形评价图 | 160对象十层同心热图；外圈分类色带、对象文字、外圈数值柱与中心图例 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/radial_cohort_dashboard_replica.webp) |

## 分布、统计与回归矩阵

| 原编号 | id / 图表 | 完整版式 | 输入补充 | 预览 |
| --- | --- | --- | --- | --- |
| 25 | `violin-mean-trends`<br>六面板分组小提琴均值矩阵 | 2×3六面板；每图九组小提琴与箱体；共用连续色标 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/violin_mean_trends_replica.webp) |
| 26 | `rank-distribution-test`<br>两组半小提琴箱线散点检验图 | 单面板；向外半小提琴、箱体与原始散点叠加；真实检验显著性横线 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/rank_distribution_test_replica.webp) |
| 27 | `polar-estimate-intervals`<br>分区径向分组均值与误差图 | 八个环形分区各四组柱与置信区间；外圈分类色带、数值刻度和中心图例 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/polar_estimate_intervals_replica.webp) |
| 29 | `importance-association-report`<br>变量重要性与稀疏相关气泡矩阵 | 40×26稀疏显著性气泡矩阵；26项顶部重要性柱、相关色标和点大小图例 | 顶部权重为演示摘要；气泡来自真实计算的相关和 p 值。 | [查看](../assets/previews/importance_association_report_replica.webp) |
| 30 | `time-regression-matrix`<br>四变量相关矩阵与年度趋势组合图 | 左侧4×4相关矩阵：直方密度、散点拟合和统计色块；右侧四层年度回归 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/time_regression_matrix_replica.webp) |

## 三维曲面、网络与集合

| 原编号 | id / 图表 | 完整版式 | 输入补充 | 预览 |
| --- | --- | --- | --- | --- |
| 32 | `surface-projection-3d`<br>三维响应面与等值底图 | 独立三维线框响应面；底部连续等值投影；竖向色标和完整变量轴 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/surface_projection_3d_replica.webp) |
| 34 | `set-overlap-report`<br>四情景集合交叠与贡献条图 | 2×2四组集合交叠图；外部全集边界、七交集计数、图旁集合图例和底部分类色卡 | 区域显示排他交集计数，外框内显示全集剩余数；圆面积不代表集合大小。 | [查看](../assets/previews/set_overlap_report_replica.webp) |

## 预测评价

| 原编号 | id / 图表 | 完整版式 | 输入补充 | 预览 |
| --- | --- | --- | --- | --- |
| 40 | `model-marginal-comparison`<br>六模型预测边缘分布与残差矩阵 | 2×3六模型；每图完整预测散点、顶部渐变直方图、右侧直方图及底部残差条 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/model_marginal_comparison_replica.webp) |

## 单样本贡献与局部响应

| 原编号 | id / 图表 | 完整版式 | 输入补充 | 预览 |
| --- | --- | --- | --- | --- |
| 43 | `attribution-waterfall`<br>单样本贡献瀑布图 | 十特征单样本瀑布；红蓝箭头条、贡献值、特征取值、基准值和最终预测 | 从基准逐项累加贡献并准确到达样本输出。 | [查看](../assets/previews/attribution_waterfall_replica.webp) |

## 关联、分组矩阵与效应分解

| 原编号 | id / 图表 | 完整版式 | 输入补充 | 预览 |
| --- | --- | --- | --- | --- |
| 46 | `lollipop-effect-grid`<br>分层标准化回归系数图 | 三类模型各三项系数；分组背景、点大小、虚线连接和右侧图例 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/lollipop_effect_grid_replica.webp) |
| 47 | `circular-effect-intervals`<br>环形标准化与原始效应比较图 | 四簇共12因素；成对环形柱、误差棒、系数环线及底部图例 | 误差棒为给定的演示误差量；真实使用需传入估计器输出。 | [查看](../assets/previews/circular_effect_intervals_replica.webp) |
| 48 | `correlation-glyph-grid`<br>椭圆相关与显著性数字矩阵 | 16变量完整矩阵；下三角相关椭圆、上三角数值及显著性、对角变量名 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/correlation_glyph_grid_replica.webp) |
| 49 | `association-network-heatmap`<br>三组相关矩阵与中心响应连线图 | 三个角落的三角相关矩阵；中心响应节点与跨面板连线；独立图例和色标 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/association_network_heatmap_replica.webp) |
| 50 | `split-cohort-correlation`<br>双变量同步性三角分割矩阵 | 15区域下三角；每格两种条件的半格三角形；分歧色标及双条件坐标标题 | 两组分别使用蓝绿与粉紫色阶，两个色标均对应 −1 到 1。 | [查看](../assets/previews/split_cohort_correlation_replica.webp) |
| 51 | `regression-uncertainty-scatter`<br>误差棒回归与连续着色散点图 | 15个误差棒散点；负向回归、零线、右上统计和图内横向连续色标 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/regression_uncertainty_scatter_replica.webp) |
| 52 | `fdr-association-map`<br>多重检验相关三角热图 | 13变量下三角相关色块；每格相关值和FDR显著性；图内显著性图例 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/fdr_association_map_replica.webp) |
| 53 | `circular-correlation-rings`<br>分组相关系数环形热图 | 24因子五层相关数值热环；内圈分组色带、中心图例、外圈名称及开口 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/circular_correlation_rings_replica.webp) |
| 54 | `grouped-block-correlation`<br>分组矩形相关矩阵与排序色带 | 20×14分组相关矩阵；左侧三类分组条、顶部色标和逐格显著性 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/grouped_block_correlation_replica.webp) |
| 55 | `cohort-correlation-bubbles`<br>四区域多变量相关气泡图 | 四行20变量气泡；大小编码相关强度、颜色编码正负、显著性透明度及侧图例 | 大小为绝对相关；颜色同时区分正负号与实际 p 值分档。 | [查看](../assets/previews/cohort_correlation_bubbles_replica.webp) |
| 57 | `interaction-bubble-grid`<br>因子交互气泡与数字矩阵 | 11×11矩阵；上三角变径气泡、下三角数值、因子标签及统一色标 | 示例点大小和数值为绝对 Pearson 相关，不声称估计交互或增强类型。 | [查看](../assets/previews/interaction_bubble_grid_replica.webp) |
| 58 | `distance-association-network`<br>距离关联网络与三角矩阵 | 18变量三角方块矩阵；四个右侧距离关联节点；变线宽曲线及色标 | Mantel 对同一距离矩阵同时置换行列，99 次置换加一修正；最小 p 为 0.01。 | [查看](../assets/previews/distance_association_network_replica.webp) |
| 59 | `grouped-scatter-matrix`<br>分组相关散点与边缘分布矩阵 | 5×5组合：4×4分组相关矩阵、右侧四组小提琴、底部四幅直方图及计数柱 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/grouped_scatter_matrix_replica.webp) |
| 60 | `pearson-correlation-map`<br>长变量列表稀疏相关矩阵 | 30行8列窄长方格矩阵；显著相关方块、顶部斜标签与长行名 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/pearson_correlation_map_replica.webp) |
| 61 | `petal-correlation-panels`<br>四分区扇形相关热图 | 四个独立扇形三角相关分区；逐格显著性、外围变量标签、中央图例和底部色标 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/petal_correlation_panels_replica.webp) |
| 62 | `grouped-regression-marginals`<br>双组回归散点与平滑边缘密度 | 金绿双组密集回归散点；顶部与右侧密度；两处组别拟合统计 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/grouped_regression_marginals_replica.webp) |
| 63 | `scatter-network-report`<br>散点上三角与外部关联网络 | 右上5×5散点三角矩阵；对角因子标签；左侧四节点网络及分组图例 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/scatter_network_report_replica.webp) |
| 66 | `network-profile-report`<br>相关网络与共线性径向报告 | 左三角相关矩阵连接目标节点；右十一变量径向VIF柱图；完整标签与色标 | 右侧柱为相关矩阵逆矩阵对角元得到的 VIF。 | [查看](../assets/previews/network_profile_report_replica.webp) |

## 特征贡献与复合效应报告

| 原编号 | id / 图表 | 完整版式 | 输入补充 | 预览 |
| --- | --- | --- | --- | --- |
| 67 | `grouped-attribution-importance`<br>分组贡献条形与蜂群联合图 | 17行分组重要性条与蜂群共用排序；顶部浅色标题带、底部横色标和三类指标图例 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/grouped_attribution_importance_replica.webp) |
| 69 | `attribution-top-feature-report`<br>特征贡献排名与六项依赖图 | 左19特征贡献条；右2×3六个贡献依赖散点、平滑拟合与置信带 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/attribution_top_feature_report_replica.webp) |
| 70 | `attribution-polar-importance`<br>镜像贡献排名蜂群与径向占比图 | 20特征镜像排名条与蜂群；左下径向占比插图；红蓝渐变及右侧色标 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/attribution_polar_importance_replica.webp) |
| 71 | `smooth-effect-residual-report`<br>十六面板平滑响应等值图 | 4×4十六等值面板；统一棕白青色标、白色实虚等值线和每图计算指标 | 16 个解析响应面；R²/RMSE 为模拟观测与已知响应面的比较。 | [查看](../assets/previews/smooth_effect_residual_report_replica.webp) |
| 73 | `effect-marginal-panel-grid`<br>十五因子效应与底部直方图矩阵 | 3×5十五个效应面板；每图底部直方图、拟合置信带、实际零交点与阈值标注 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/effect_marginal_panel_grid_replica.webp) |
| 74 | `attribution-threshold-report`<br>九因子阈值与正负贡献图 | 3×3九个阈值图；正负区域填色、蓝色拟合置信带、红色零交点与每图统计 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/attribution_threshold_report_replica.webp) |
| 75 | `conditional-effect-histogram`<br>条件贡献回归与背景分布图 | 背景直方图与彩色贡献散点；两条件回归及置信带、双轴和色标 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/conditional_effect_histogram_replica.webp) |
| 76 | `attribution-dependence-report`<br>贡献蜂群与六变量阈值依赖报告 | 19特征蜂群叠加灰色重要性条；右侧3×2彩色依赖图，每图阈值、中位线和色标 | 两种竖线分别标记特征中位数与第 65 百分位，不将其称为因果阈值。 | [查看](../assets/previews/attribution_dependence_report_replica.webp) |
| 77 | `interaction-network`<br>密集特征交互环形网络 | 18节点完整环网；交互强度控制边色和线宽、节点重要性控制颜色与大小；双独立色标 | 边为解析双线性交互模型的对称系数，节点大小为平均边强度。 | [查看](../assets/previews/interaction_network_replica.webp) |
| 79 | `attribution-intervals`<br>多特征贡献均值区间排名图 | 30特征窄长区间图；逐项不同颜色、均值点与横向置信区间、零参考线 | 区间为平均绝对贡献的 t 均值区间。 | [查看](../assets/previews/attribution_intervals_replica.webp) |
| 80 | `multiresponse-effect-curves`<br>四响应贡献回归叠加图 | 四响应单面板叠加；散点、非线性拟合及置信带；调整R²和底部分类图例 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/multiresponse_effect_curves_replica.webp) |

## 响应面与空间网格

| 原编号 | id / 图表 | 完整版式 | 输入补充 | 预览 |
| --- | --- | --- | --- | --- |
| 81 | `response-contour-matrix`<br>六对变量响应等值面板 | 2×3六变量对响应等值图；每图等值线数值、坐标名和独立连续色标 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/response_contour_matrix_replica.webp) |
| 82 | `pixel-regression-maps`<br>像元主导因子分类图 | 单幅细密像元主导因子图；四个离散类别及逐类色标 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/pixel_regression_maps_replica.webp) |
| 83 | `moving-window-partial-correlation`<br>空间网格偏相关热图 | 单幅空间偏相关栅格；实际控制变量残差相关计算；固定[-1,1]色标 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/moving_window_partial_correlation_replica.webp) |
| 84 | `spatial-attribution-maps`<br>不规则区域主导特征图 | 白色画布上的不规则区域像元图；两个主导特征类别、区域外掩膜及色标 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/spatial_attribution_maps_replica.webp) |
| 85 | `spatial-attribution-summary`<br>分区长列表贡献分布图 | 30行空间分组贡献散点；长标签、零线、分组分隔线和连续色标 | 区域贡献散点为示例抽样，不声称已运行空间模型解释算法。 | [查看](../assets/previews/spatial_attribution_summary_replica.webp) |

## 时间序列

| 原编号 | id / 图表 | 完整版式 | 输入补充 | 预览 |
| --- | --- | --- | --- | --- |
| 86 | `dual-axis-time-comparison`<br>充放电功率与储能时序图 | 24小时正负渐变功率柱；红色储能折线和右轴；储能由功率累计计算 | 按本页对应图族的数据说明替换示例输入。 | [查看](../assets/previews/dual_axis_time_comparison_replica.webp) |
