#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT_MAP = {
    "principal-coordinate-map": "make_principal_coordinate_map.py",
    "redundancy-ordination": "make_redundancy_ordination.py",
    "pca-association-network": "make_pca_association_network.py",
    "circular-ranking-bars": "make_circular_ranking_bars.py",
    "horizontal-share-bars": "make_horizontal_share_bars.py",
    "polar-area-panels": "make_polar_area_panels.py",
    "radial-stacked-sectors": "make_radial_stacked_sectors.py",
    "ribbon-trajectories-3d": "make_ribbon_trajectories_3d.py",
    "waterfall-density-3d": "make_waterfall_density_3d.py",
    "layered-heatmaps-3d": "make_layered_heatmaps_3d.py",
    "column-grid-3d": "make_column_grid_3d.py",
    "violin-mean-trends": "make_violin_mean_trends.py",
    "rank-distribution-test": "make_rank_distribution_test.py",
    "polar-estimate-intervals": "make_polar_estimate_intervals.py",
    "surface-projection-3d": "make_surface_projection_3d.py",
    "set-overlap-report": "make_set_overlap_report.py",
    "importance-association-report": "make_importance_association_report.py",
    "time-regression-matrix": "make_time_regression_matrix.py",
    "lollipop-effect-grid": "make_lollipop_effect_grid.py",
    "circular-effect-intervals": "make_circular_effect_intervals.py",
    "correlation-glyph-grid": "make_correlation_glyph_grid.py",
    "association-network-heatmap": "make_association_network_heatmap.py",
    "split-cohort-correlation": "make_split_cohort_correlation.py",
    "regression-uncertainty-scatter": "make_regression_uncertainty_scatter.py",
    "fdr-association-map": "make_fdr_association_map.py",
    "grouped-block-correlation": "make_grouped_block_correlation.py",
    "cohort-correlation-bubbles": "make_cohort_correlation_bubbles.py",
    "interaction-bubble-grid": "make_interaction_bubble_grid.py",
    "distance-association-network": "make_distance_association_network.py",
    "grouped-scatter-matrix": "make_grouped_scatter_matrix.py",
    "pearson-correlation-map": "make_pearson_correlation_map.py",
    "petal-correlation-panels": "make_petal_correlation_panels.py",
    "grouped-regression-marginals": "make_grouped_regression_marginals.py",
    "scatter-network-report": "make_scatter_network_report.py",
    "network-profile-report": "make_network_profile_report.py",
    "attribution-matrix-summary": "make_attribution_matrix_summary.py",
    "attribution-waterfall": "make_attribution_waterfall.py",
    "grouped-attribution-importance": "make_grouped_attribution_importance.py",
    "attribution-top-feature-report": "make_attribution_top_feature_report.py",
    "attribution-polar-importance": "make_attribution_polar_importance.py",
    "smooth-effect-residual-report": "make_smooth_effect_residual_report.py",
    "attribution-threshold-report": "make_attribution_threshold_report.py",
    "interaction-network": "make_interaction_network.py",
    "attribution-intervals": "make_attribution_intervals.py",
    "multiresponse-effect-curves": "make_multiresponse_effect_curves.py",
    "pixel-regression-maps": "make_pixel_regression_maps.py",
    "moving-window-partial-correlation": "make_moving_window_partial_correlation.py",
    "spatial-attribution-maps": "make_spatial_attribution_maps.py",
    "dual-axis-time-comparison": "make_dual_axis_time_comparison.py",
    "pca-variance-report": "make_pca_variance_report.py",
    "clustered-rank-correlation": "make_clustered_rank_correlation.py",
    "ternary-composition": "make_ternary_composition.py",
    "multiclass-shap-combo": "make_multiclass_shap_combo.py",
    "paired-raincloud": "make_paired_raincloud.py",
    "cv-roc-ci": "make_cv_roc_ci.py",
    "taylor-diagram": "make_taylor_diagram.py",
    "correlation-pairgrid": "make_correlation_pairgrid.py",
    "prediction-marginal-grid": "make_prediction_marginal_grid.py",
    "rf-tpe-surface": "make_rf_tpe_surface.py",
    "grouped-corr-split-violin": "make_grouped_corr_split_violin.py",
    "grouped-circular-heatmap": "make_grouped_circular_heatmap.py",
    "urban-park-cooling-combo": "make_urban_park_cooling_combo.py",
    "nature-chord-diagram": "make_nature_chord_diagram.py",
    "land-diurnal-lst-maps": "make_land_diurnal_lst_maps.py",
    "land-morphology-lst-linear": "make_land_morphology_lst_linear.py",
    "land-morphology-lst-nonlinear": "make_land_morphology_lst_nonlinear.py",
    "land-diurnal-feature-importance": "make_land_diurnal_feature_importance.py",
    "land-shap-interactions": "make_land_shap_interactions.py",
    "land-model-prediction-comparison": "make_land_model_prediction_comparison.py",
    "sr-weather-model-evaluation-map": "make_sr_weather_model_evaluation_map.py",
    "sr-weather-downscaling-map": "make_sr_weather_downscaling_map.py",
    "karst-es-sdg-sankey": "make_karst_es_sdg_sankey.py",
    "karst-land-use-scenarios": "make_karst_land_use_scenarios.py",
    "karst-ecosystem-services-atlas": "make_karst_ecosystem_services_atlas.py",
    "karst-es-hotspot-scenarios": "make_karst_es_hotspot_scenarios.py",
    "esv-grid-zone-scenarios": "make_esv_grid_zone_scenarios.py",
    "esv-local-moran-scenarios": "make_esv_local_moran_scenarios.py",
    "landslide-shap-decision-heatmaps": "make_landslide_shap_decision_heatmaps.py",
    "landslide-pdp-interaction-grid": "make_landslide_pdp_interaction_grid.py",
    "biodiversity-global-delta-atlas": "make_biodiversity_global_delta_atlas.py",
    "biodiversity-global-correlation-atlas": "make_biodiversity_global_correlation_atlas.py",
    "ranked-feature-heatmap": "make_ranked_feature_heatmap.py",
    "radial-cohort-dashboard": "make_radial_cohort_dashboard.py",
    "model-marginal-comparison": "make_model_marginal_comparison.py",
    "circular-correlation-rings": "make_circular_correlation_rings.py",
    "effect-marginal-panel-grid": "make_effect_marginal_panel_grid.py",
    "conditional-effect-histogram": "make_conditional_effect_histogram.py",
    "attribution-dependence-report": "make_attribution_dependence_report.py",
    "response-contour-matrix": "make_response_contour_matrix.py",
    "spatial-attribution-summary": "make_spatial_attribution_summary.py",
}

ALIASES = {
    "pcoa": "principal-coordinate-map",
    "rda": "redundancy-ordination",
    "mantel": "distance-association-network",
    "venn": "set-overlap-report",
    "shap-waterfall": "attribution-waterfall",
    "pca": "pca-variance-report",
    "clustered-correlation": "clustered-rank-correlation",
    "ternary": "ternary-composition",
    "shap": "multiclass-shap-combo",
    "multiclass-shap": "multiclass-shap-combo",
    "raincloud": "paired-raincloud",
    "roc": "cv-roc-ci",
    "cv-roc": "cv-roc-ci",
    "taylor": "taylor-diagram",
    "pairgrid": "correlation-pairgrid",
    "correlation": "correlation-pairgrid",
    "pred-true": "prediction-marginal-grid",
    "prediction": "prediction-marginal-grid",
    "surface": "rf-tpe-surface",
    "tpe": "rf-tpe-surface",
    "split-violin": "grouped-corr-split-violin",
    "circular-heatmap": "grouped-circular-heatmap",
    "urban-cooling": "urban-park-cooling-combo",
    "chord": "nature-chord-diagram",
    "circos": "nature-chord-diagram",
    "diurnal-lst": "land-diurnal-lst-maps",
    "morphology-linear": "land-morphology-lst-linear",
    "morphology-nonlinear": "land-morphology-lst-nonlinear",
    "feature-importance": "land-diurnal-feature-importance",
    "shap-interactions": "land-shap-interactions",
    "model-comparison": "land-model-prediction-comparison",
    "weather-evaluation-map": "sr-weather-model-evaluation-map",
    "weather-downscaling-map": "sr-weather-downscaling-map",
    "sr-weather-figure-2": "sr-weather-model-evaluation-map",
    "sr-weather-figure-5": "sr-weather-downscaling-map",
    "es-sdg": "karst-es-sdg-sankey",
    "karst-sankey": "karst-es-sdg-sankey",
    "karst-land-use": "karst-land-use-scenarios",
    "karst-es-atlas": "karst-ecosystem-services-atlas",
    "karst-hotspot": "karst-es-hotspot-scenarios",
    "esv-zones": "esv-grid-zone-scenarios",
    "lisa-map": "esv-local-moran-scenarios",
    "local-moran": "esv-local-moran-scenarios",
    "shap-decision-heatmap": "landslide-shap-decision-heatmaps",
    "pdp-interaction": "landslide-pdp-interaction-grid",
    "global-delta-atlas": "biodiversity-global-delta-atlas",
    "global-correlation-atlas": "biodiversity-global-correlation-atlas",
}

CJK_HINTS = {
    "主坐标排序与边缘分布图": "principal-coordinate-map",
    "约束排序与解释变量方向图": "redundancy-ordination",
    "主成分与变量关联网络图": "pca-association-network",
    "同心圆弧排名图": "circular-ranking-bars",
    "横向百分比组成条形图": "horizontal-share-bars",
    "多组极坐标面积统计图": "polar-area-panels",
    "径向分组堆叠柱图": "radial-stacked-sectors",
    "三维分组条带轨迹图": "ribbon-trajectories-3d",
    "三维瀑布分布图": "waterfall-density-3d",
    "三维分层矩阵热图": "layered-heatmaps-3d",
    "三维数值矩阵柱图": "column-grid-3d",
    "两组秩检验与分布对比图": "rank-distribution-test",
    "极坐标估计值与置信区间图": "polar-estimate-intervals",
    "三维响应面与底部等值投影": "surface-projection-3d",
    "集合交叠与精确交集计数图": "set-overlap-report",
    "变量重要性与相关矩阵联合图": "importance-association-report",
    "变量散点矩阵与时间趋势报告": "time-regression-matrix",
    "多模型系数棒棒糖图": "lollipop-effect-grid",
    "环形正负效应与区间图": "circular-effect-intervals",
    "相关系数与椭圆编码矩阵": "correlation-glyph-grid",
    "关联网络与热图组合图": "association-network-heatmap",
    "双组对角分割相关矩阵": "split-cohort-correlation",
    "测量误差与回归区间散点图": "regression-uncertainty-scatter",
    "多重检验校正相关热图": "fdr-association-map",
    "分组标注相关块矩阵": "grouped-block-correlation",
    "多队列相关气泡矩阵": "cohort-correlation-bubbles",
    "双变量交互强度气泡图": "interaction-bubble-grid",
    "距离矩阵置换检验网络图": "distance-association-network",
    "多组散点与分布矩阵": "grouped-scatter-matrix",
    "带数值标注的相关矩阵图": "pearson-correlation-map",
    "花瓣式分组相关热图": "petal-correlation-panels",
    "分组回归与边缘分布图": "grouped-regression-marginals",
    "散点关系与变量网络报告": "scatter-network-report",
    "相关网络与指标轮廓报告": "network-profile-report",
    "特征贡献热图与汇总条形图": "attribution-matrix-summary",
    "单样本特征贡献瀑布图": "attribution-waterfall",
    "分组特征重要性与贡献分布图": "grouped-attribution-importance",
    "重要性与头部特征效应小多图": "attribution-top-feature-report",
    "特征重要性条形与极坐标汇总图": "attribution-polar-importance",
    "特征效应与样本分布阈值图": "attribution-threshold-report",
    "特征交互贡献网络图": "interaction-network",
    "多响应变量效应拟合曲线图": "multiresponse-effect-curves",
    "逐格标准化回归与主导因子图": "pixel-regression-maps",
    "移动窗口偏相关栅格图": "moving-window-partial-correlation",
    "空间特征贡献与主导因子图": "spatial-attribution-maps",
    "双单位柱线时间序列图": "dual-axis-time-comparison",
    "pca": "pca-variance-report",
    "聚类秩相关": "clustered-rank-correlation",
    "三元": "ternary-composition",
    "多分类": "multiclass-shap-combo",
    "shap交互": "land-shap-interactions",
    "shap": "multiclass-shap-combo",
    "云雨": "paired-raincloud",
    "roc": "cv-roc-ci",
    "泰勒": "taylor-diagram",
    "相关矩阵组合": "correlation-pairgrid",
    "拟合线": "correlation-pairgrid",
    "模型预测对比": "land-model-prediction-comparison",
    "预测": "prediction-marginal-grid",
    "真实": "prediction-marginal-grid",
    "tpe": "rf-tpe-surface",
    "曲面": "rf-tpe-surface",
    "半边小提琴": "grouped-corr-split-violin",
    "环形热图": "grouped-circular-heatmap",
    "城市公园": "urban-park-cooling-combo",
    "堆叠": "urban-park-cooling-combo",
    "和弦": "nature-chord-diagram",
    "circos": "nature-chord-diagram",
    "昼夜地表温度": "land-diurnal-lst-maps",
    "形态线性": "land-morphology-lst-linear",
    "形态非线性": "land-morphology-lst-nonlinear",
    "特征重要性": "land-diurnal-feature-importance",
    "气象模型评估地图": "sr-weather-model-evaluation-map",
    "气象超分辨率": "sr-weather-downscaling-map",
    "天气降尺度": "sr-weather-downscaling-map",
    "生态系统服务与sdg": "karst-es-sdg-sankey",
    "喀斯特土地利用": "karst-land-use-scenarios",
    "生态系统服务图集": "karst-ecosystem-services-atlas",
    "喀斯特热点": "karst-es-hotspot-scenarios",
    "生态系统服务价值分级": "esv-grid-zone-scenarios",
    "局部空间自相关": "esv-local-moran-scenarios",
    "局部莫兰": "esv-local-moran-scenarios",
    "shap决策热图": "landslide-shap-decision-heatmaps",
    "pdp交互": "landslide-pdp-interaction-grid",
    "双变量交互等值图": "landslide-pdp-interaction-grid",
    "全球温度差异图集": "biodiversity-global-delta-atlas",
    "全球相关地图": "biodiversity-global-correlation-atlas",
    "三角相关矩阵与主成分连线图": "pca-association-network",
    "双向层次聚类相关热图": "clustered-rank-correlation",
    "主坐标排序与边缘密度图": "principal-coordinate-map",
    "多编码约束排序图": "redundancy-ordination",
    "三元组成与连续变量气泡图": "ternary-composition",
    "横向组成比例与连接带图": "horizontal-share-bars",
    "九宫格径向扇区分布图": "polar-area-panels",
    "多对象径向堆叠柱图": "radial-stacked-sectors",
    "排名柱形与贡献热图联合报告": "ranked-feature-heatmap",
    "多组年度三维条带图": "ribbon-trajectories-3d",
    "多组多阶段三维瀑布峰图": "waterfall-density-3d",
    "四层三维矩阵热图": "layered-heatmaps-3d",
    "规则矩阵三维柱图": "column-grid-3d",
    "多队列密集环形评价图": "radial-cohort-dashboard",
    "六面板分组小提琴均值矩阵": "violin-mean-trends",
    "两组半小提琴箱线散点检验图": "rank-distribution-test",
    "分区径向分组均值与误差图": "polar-estimate-intervals",
    "变量重要性与稀疏相关气泡矩阵": "importance-association-report",
    "四变量相关矩阵与年度趋势组合图": "time-regression-matrix",
    "三维响应面与等值底图": "surface-projection-3d",
    "四情景集合交叠与贡献条图": "set-overlap-report",
    "六模型预测边缘分布与残差矩阵": "model-marginal-comparison",
    "单样本贡献瀑布图": "attribution-waterfall",
    "分层标准化回归系数图": "lollipop-effect-grid",
    "环形标准化与原始效应比较图": "circular-effect-intervals",
    "椭圆相关与显著性数字矩阵": "correlation-glyph-grid",
    "三组相关矩阵与中心响应连线图": "association-network-heatmap",
    "双变量同步性三角分割矩阵": "split-cohort-correlation",
    "误差棒回归与连续着色散点图": "regression-uncertainty-scatter",
    "多重检验相关三角热图": "fdr-association-map",
    "分组相关系数环形热图": "circular-correlation-rings",
    "分组矩形相关矩阵与排序色带": "grouped-block-correlation",
    "四区域多变量相关气泡图": "cohort-correlation-bubbles",
    "因子交互气泡与数字矩阵": "interaction-bubble-grid",
    "距离关联网络与三角矩阵": "distance-association-network",
    "分组相关散点与边缘分布矩阵": "grouped-scatter-matrix",
    "长变量列表稀疏相关矩阵": "pearson-correlation-map",
    "四分区扇形相关热图": "petal-correlation-panels",
    "双组回归散点与平滑边缘密度": "grouped-regression-marginals",
    "散点上三角与外部关联网络": "scatter-network-report",
    "相关网络与共线性径向报告": "network-profile-report",
    "分组贡献条形与蜂群联合图": "grouped-attribution-importance",
    "特征贡献排名与六项依赖图": "attribution-top-feature-report",
    "镜像贡献排名蜂群与径向占比图": "attribution-polar-importance",
    "十六面板平滑响应等值图": "smooth-effect-residual-report",
    "十五因子效应与底部直方图矩阵": "effect-marginal-panel-grid",
    "九因子阈值与正负贡献图": "attribution-threshold-report",
    "条件贡献回归与背景分布图": "conditional-effect-histogram",
    "贡献蜂群与六变量阈值依赖报告": "attribution-dependence-report",
    "密集特征交互环形网络": "interaction-network",
    "多特征贡献均值区间排名图": "attribution-intervals",
    "四响应贡献回归叠加图": "multiresponse-effect-curves",
    "六对变量响应等值面板": "response-contour-matrix",
    "像元主导因子分类图": "pixel-regression-maps",
    "空间网格偏相关热图": "moving-window-partial-correlation",
    "不规则区域主导特征图": "spatial-attribution-maps",
    "分区长列表贡献分布图": "spatial-attribution-summary",
    "充放电功率与储能时序图": "dual-axis-time-comparison",
}

KOREA_DATA_TEMPLATE_IDS = {
    "sr-weather-model-evaluation-map",
    "sr-weather-downscaling-map",
}

KARST_DATA_TEMPLATE_IDS = {
    "karst-land-use-scenarios",
    "karst-ecosystem-services-atlas",
    "karst-es-hotspot-scenarios",
}

GUB_DATA_TEMPLATE_IDS = {
    "esv-grid-zone-scenarios",
    "esv-local-moran-scenarios",
}

WORLD_DATA_TEMPLATE_IDS = {
    "biodiversity-global-delta-atlas",
    "biodiversity-global-correlation-atlas",
}

DATA_TEMPLATE_IDS = (
    KOREA_DATA_TEMPLATE_IDS | KARST_DATA_TEMPLATE_IDS | GUB_DATA_TEMPLATE_IDS
)

TIFF_TEMPLATE_IDS = DATA_TEMPLATE_IDS | {"karst-es-sdg-sankey"}


def normalize(value: str) -> str:
    value = value.strip().lower().replace("_", "-")
    value = re.sub(r"[^a-z0-9\-]+", "-", value)
    value = re.sub(r"-+", "-", value).strip("-")
    return value


def resolve_template(value: str) -> str:
    raw = value.strip()
    # A complete title is more specific than an English acronym left after
    # normalization (for example, a Chinese title containing ROC).
    for title, template_id in CJK_HINTS.items():
        if raw.casefold() == title.casefold():
            return template_id
    key = normalize(raw)
    if key in SCRIPT_MAP:
        return key
    if key in ALIASES:
        return ALIASES[key]
    lowered = raw.lower()
    for hint, template_id in CJK_HINTS.items():
        if hint.lower() in lowered:
            return template_id
    raise SystemExit(
        f"Unknown template: {value}\nAvailable ids: " + ", ".join(sorted(SCRIPT_MAP))
    )


def output_suffixes(template_id: str) -> tuple[str, ...]:
    suffixes = (".png", ".pdf", ".svg")
    if template_id in TIFF_TEMPLATE_IDS:
        suffixes += (".tiff",)
    return suffixes


def prepare_template_assets(skill_root: Path, project: Path, template_id: str) -> None:
    if template_id in KOREA_DATA_TEMPLATE_IDS:
        source_data = skill_root / "assets" / "data" / "korea_srtm_dem.npz"
        target_data = project / "data" / source_data.name
        target_data.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_data, target_data)

        source_cartopy = skill_root / "assets" / "cartopy"
        target_cartopy = project / ".cartopy"
        shutil.copytree(source_cartopy, target_cartopy, dirs_exist_ok=True)

    if template_id in KARST_DATA_TEMPLATE_IDS:
        source_data = (
            skill_root / "assets" / "data" / "karst_southeast_yunnan_boundary.json"
        )
        target_data = project / "data" / source_data.name
        target_data.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_data, target_data)

    if template_id in GUB_DATA_TEMPLATE_IDS:
        source_data = (
            skill_root / "assets" / "data" / "ganjiang_upstream_basin_boundary.json"
        )
        target_data = project / "data" / source_data.name
        target_data.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_data, target_data)

    if template_id in WORLD_DATA_TEMPLATE_IDS:
        source_data = (
            skill_root / "assets" / "data" / "natural_earth_world_simplified.geojson"
        )
        target_data = project / "data" / source_data.name
        target_data.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_data, target_data)


def write_readme(project: Path, template_id: str, script_path: Path) -> None:
    readme = project / "README.md"
    output_stem = (
        project / "outputs" / f"{script_path.stem.removeprefix('make_')}_replica"
    )
    output_lines = "\n".join(
        f"- `{output_stem.with_suffix(suffix).as_posix()}`"
        for suffix in output_suffixes(template_id)
    )
    block = f"""
## {template_id}

Generated from the bundled MathModel figure-template skill.

```bash
python3 {script_path.as_posix()}
```

Outputs:

{output_lines}
""".strip()
    if readme.exists():
        text = readme.read_text(encoding="utf-8")
        marker = f"## {template_id}"
        if marker in text:
            return
        readme.write_text(text.rstrip() + "\n\n" + block + "\n", encoding="utf-8")
    else:
        readme.write_text("# 绘图复刻\n\n" + block + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Render a bundled MathModel figure template."
    )
    parser.add_argument(
        "template", nargs="?", help="Template id, alias, or Chinese title fragment"
    )
    parser.add_argument(
        "--project",
        default="绘图复刻",
        help="Output project directory, default: 绘图复刻",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite an existing copied workspace script",
    )
    parser.add_argument(
        "--list", action="store_true", help="List supported template ids"
    )
    args = parser.parse_args()

    if args.list:
        for template_id in sorted(SCRIPT_MAP):
            print(template_id)
        return
    if not args.template:
        parser.error("template is required unless --list is used")

    template_id = resolve_template(args.template)
    skill_root = Path(__file__).resolve().parents[1]
    src = skill_root / "scripts" / "templates" / SCRIPT_MAP[template_id]
    if not src.exists():
        raise SystemExit(f"Bundled script missing: {src}")

    project = Path(args.project).expanduser().resolve()
    scripts_dir = project / "scripts"
    outputs_dir = project / "outputs"
    mpl_dir = project / ".mplconfig"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    outputs_dir.mkdir(parents=True, exist_ok=True)
    mpl_dir.mkdir(parents=True, exist_ok=True)

    dst = scripts_dir / src.name
    if dst.exists() and not args.overwrite:
        print(f"Using existing workspace script: {dst}")
    else:
        shutil.copy2(src, dst)
        print(f"Copied template script: {dst}")

    prepare_template_assets(skill_root, project, template_id)

    result = subprocess.run([sys.executable, str(dst)], cwd=str(project), check=False)
    if result.returncode != 0:
        raise SystemExit(result.returncode)

    write_readme(project, template_id, dst)

    stem = dst.stem.removeprefix("make_")
    for suffix in output_suffixes(template_id):
        path = outputs_dir / f"{stem}_replica{suffix}"
        print(path)


if __name__ == "__main__":
    main()
