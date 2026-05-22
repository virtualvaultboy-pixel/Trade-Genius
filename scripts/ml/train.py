#!/usr/bin/env python3
"""
Trade Genius — v4.0 ML Pipeline · Étape 2/3 : Train models

Pour chaque horizon (DAY, WEEK, MONTH), on entraîne un XGBoost binaire :
WIN (label=+1) vs PAS_WIN (label=0 OU -1). On veut prédire la probabilité
qu'un trade LONG entré au close[D] atteigne sa cible avant son stop.

On utilise une split temporelle (pas k-fold aléatoire) pour éviter le leak :
  train : 80% les plus anciens
  test  : 20% les plus récents

Output :
  - data/ml/model_day.json     (decision rules JSON serialisable)
  - data/ml/model_week.json
  - data/ml/model_month.json
  - data/ml/metrics.json       (accuracy, precision, recall, AUC par horizon
                                + feature importance)

Lancement local :
    pip install -r scripts/ml/requirements.txt
    python scripts/ml/train.py

Workflow GH : ml-train.yml (job entraînement)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score, roc_auc_score,
    confusion_matrix,
)

ROOT = Path(__file__).resolve().parents[2]
DATASET_PATH = ROOT / "data" / "ml" / "dataset.csv"
OUT_DIR = ROOT / "data" / "ml"

FEATURE_KEYS = [
    "rsi", "macd_line", "macd_signal", "macd_hist",
    "ma20_rel", "ma50_rel", "ma200_rel", "ma50_slope",
    "boll_pos", "atr_pct", "adx", "stoch_k", "stoch_d",
    "ichi_pos", "ichi_sig", "vol20", "chg5", "chg20", "regime",
]

HORIZONS = [
    {"key": "day", "label_col": "label_day"},
    {"key": "week", "label_col": "label_week"},
    {"key": "month", "label_col": "label_month"},
]


def load_dataset() -> pd.DataFrame:
    if not DATASET_PATH.exists():
        print(f"ERROR: dataset {DATASET_PATH} not found. Run build-dataset.mjs first.")
        sys.exit(1)
    df = pd.read_csv(DATASET_PATH)
    print(f"Loaded {len(df)} rows × {len(df.columns)} cols")
    return df


def train_one(df: pd.DataFrame, horizon: dict) -> dict:
    label_col = horizon["label_col"]
    key = horizon["key"]
    print(f"\n=== Training {key.upper()} ===")
    # On vire les rows sans label (NaN ou vide)
    sub = df[df[label_col].notna()].copy()
    sub = sub[sub[label_col] != ""]
    sub[label_col] = pd.to_numeric(sub[label_col], errors="coerce")
    sub = sub.dropna(subset=[label_col])
    # Binary : WIN (+1) vs PAS_WIN (0 ou -1)
    sub["y"] = (sub[label_col] > 0).astype(int)
    print(f"  Rows: {len(sub)}  ·  win rate: {sub['y'].mean():.3f}")

    if len(sub) < 5000:
        print(f"  WARNING: too few samples ({len(sub)}), skipping {key}")
        return None

    X = sub[FEATURE_KEYS].values
    y = sub["y"].values

    # Split temporel : on assume que le CSV est ordonné par asset puis idx.
    # Plus solide : prendre 80% des assets pour train et garder 20% out.
    # Ici simplification : split sur l'ordre des lignes (chronologique pour
    # chaque asset grâce à idx croissant).
    split = int(0.8 * len(sub))
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]
    print(f"  Train: {len(X_train)}  Test: {len(X_test)}")

    # XGBoost classifier (params conservateurs)
    clf = xgb.XGBClassifier(
        n_estimators=300,
        max_depth=5,
        learning_rate=0.05,
        subsample=0.85,
        colsample_bytree=0.85,
        min_child_weight=5,
        reg_lambda=1.0,
        objective="binary:logistic",
        eval_metric="auc",
        tree_method="hist",
        n_jobs=-1,
        random_state=42,
    )
    clf.fit(X_train, y_train, eval_set=[(X_test, y_test)], verbose=False)

    y_pred_prob = clf.predict_proba(X_test)[:, 1]
    y_pred = (y_pred_prob >= 0.5).astype(int)

    metrics = {
        "horizon": key,
        "n_train": int(len(X_train)),
        "n_test": int(len(X_test)),
        "win_rate_train": float(y_train.mean()),
        "win_rate_test": float(y_test.mean()),
        "accuracy": float(accuracy_score(y_test, y_pred)),
        "precision": float(precision_score(y_test, y_pred, zero_division=0)),
        "recall": float(recall_score(y_test, y_pred, zero_division=0)),
        "auc": float(roc_auc_score(y_test, y_pred_prob)),
        "confusion_matrix": confusion_matrix(y_test, y_pred).tolist(),
        "feature_importance": {
            k: float(v) for k, v in zip(FEATURE_KEYS, clf.feature_importances_)
        },
    }
    print(f"  AUC: {metrics['auc']:.4f}  Acc: {metrics['accuracy']:.4f}")
    print(f"  Top features:")
    fi_sorted = sorted(
        metrics["feature_importance"].items(), key=lambda kv: -kv[1]
    )[:5]
    for name, imp in fi_sorted:
        print(f"    {name:14s} {imp:.4f}")

    # Sauvegarde du modèle au format JSON (xgboost native)
    model_path = OUT_DIR / f"model_{key}.json"
    clf.save_model(str(model_path))
    print(f"  Saved model → {model_path}")
    return metrics


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    df = load_dataset()
    all_metrics = []
    for h in HORIZONS:
        m = train_one(df, h)
        if m is not None:
            all_metrics.append(m)
    metrics_path = OUT_DIR / "metrics.json"
    with metrics_path.open("w") as f:
        json.dump({"horizons": all_metrics, "feature_keys": FEATURE_KEYS}, f, indent=2)
    print(f"\nMetrics written to {metrics_path}")


if __name__ == "__main__":
    main()
