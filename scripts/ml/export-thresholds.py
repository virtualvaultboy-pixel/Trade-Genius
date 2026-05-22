#!/usr/bin/env python3
"""
Trade Genius — v4.0 ML Pipeline · Étape 3/3 : Export thresholds

À partir des modèles entraînés (model_day.json, model_week.json,
model_month.json), produit un fichier data/ml/rules.json consommable
par build-ai-study.mjs côté Node :

  {
    "version": "4.0",
    "trained_at": "2026-05-22T...",
    "horizons": {
      "day":   { "auc": 0.74, "thr_high": 0.62, "thr_med": 0.55, ... },
      "week":  { ... },
      "month": { ... },
    },
    "feature_importance_top10": { "day": [...], "week": [...], "month": [...] }
  }

Le but : build-ai-study peut ajuster son quality_score en multipliant
par la prob ML (booster les setups que XGBoost juge plus probables).

Lancement local :
    python scripts/ml/export-thresholds.py
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb

ROOT = Path(__file__).resolve().parents[2]
ML_DIR = ROOT / "data" / "ml"
DATASET_PATH = ML_DIR / "dataset.csv"
METRICS_PATH = ML_DIR / "metrics.json"
OUTPUT_PATH = ML_DIR / "rules.json"

FEATURE_KEYS = [
    "rsi", "macd_line", "macd_signal", "macd_hist",
    "ma20_rel", "ma50_rel", "ma200_rel", "ma50_slope",
    "boll_pos", "atr_pct", "adx", "stoch_k", "stoch_d",
    "ichi_pos", "ichi_sig", "vol20", "chg5", "chg20", "regime",
]

HORIZONS = ["day", "week", "month"]


def compute_thresholds(model_path: Path, df: pd.DataFrame, label_col: str) -> dict:
    clf = xgb.XGBClassifier()
    clf.load_model(str(model_path))
    sub = df[df[label_col].notna()].copy()
    sub = sub[sub[label_col] != ""]
    sub[label_col] = pd.to_numeric(sub[label_col], errors="coerce")
    sub = sub.dropna(subset=[label_col])
    sub["y"] = (sub[label_col] > 0).astype(int)
    X = sub[FEATURE_KEYS].values
    probs = clf.predict_proba(X)[:, 1]
    # Quantiles 75% et 90% = thresholds high-conviction / medium-conviction
    thr_high = float(np.quantile(probs, 0.90))
    thr_med = float(np.quantile(probs, 0.75))
    thr_low = float(np.quantile(probs, 0.50))
    return {
        "thr_high": thr_high,
        "thr_med": thr_med,
        "thr_low": thr_low,
        "mean_prob": float(probs.mean()),
        "std_prob": float(probs.std()),
    }


def main() -> None:
    if not DATASET_PATH.exists():
        print(f"ERROR: dataset missing at {DATASET_PATH}")
        return
    if not METRICS_PATH.exists():
        print(f"ERROR: metrics missing at {METRICS_PATH} (run train.py first)")
        return
    df = pd.read_csv(DATASET_PATH)
    with METRICS_PATH.open() as f:
        metrics = json.load(f)
    by_horizon = {m["horizon"]: m for m in metrics.get("horizons", [])}

    horizons_out = {}
    fi_top10 = {}
    for h in HORIZONS:
        model_path = ML_DIR / f"model_{h}.json"
        if not model_path.exists():
            print(f"  skip {h}: model not found")
            continue
        m = by_horizon.get(h, {})
        thr = compute_thresholds(model_path, df, f"label_{h}")
        horizons_out[h] = {
            "auc": m.get("auc"),
            "accuracy": m.get("accuracy"),
            "precision": m.get("precision"),
            "win_rate_test": m.get("win_rate_test"),
            **thr,
        }
        fi = m.get("feature_importance", {})
        top10 = sorted(fi.items(), key=lambda kv: -kv[1])[:10]
        fi_top10[h] = [{"feature": k, "importance": v} for k, v in top10]

    out = {
        "version": "4.0",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "feature_keys": FEATURE_KEYS,
        "horizons": horizons_out,
        "feature_importance_top10": fi_top10,
    }
    with OUTPUT_PATH.open("w") as f:
        json.dump(out, f, indent=2)
    print(f"Wrote {OUTPUT_PATH}")
    print(json.dumps(horizons_out, indent=2))


if __name__ == "__main__":
    main()
