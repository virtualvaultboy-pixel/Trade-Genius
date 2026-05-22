# Trade Genius — v4.0 ML Pipeline

Scaffold de pipeline ML (XGBoost) qui apprend à prédire si un setup LONG
atteindra sa cible avant son stop, à partir de ~25 features techniques
extraites de 50 actifs × 20 ans Yahoo daily.

## Architecture

```
scripts/ml/
├── build-dataset.mjs    (Node) — extrait CSV features + labels forward-looking
├── train.py             (Python) — entraîne 3 XGBoost (DAY/WEEK/MONTH)
├── export-thresholds.py (Python) — export rules.json consommable Node
├── requirements.txt
└── README.md
```

Data flow :
```
Yahoo prices  →  build-dataset.mjs  →  data/ml/dataset.csv  (~500k rows)
                                          ↓
                                       train.py  →  data/ml/model_{day,week,month}.json
                                                    data/ml/metrics.json
                                          ↓
                                  export-thresholds.py  →  data/ml/rules.json
                                                                  ↓
                                                    build-ai-study.mjs (optionnel)
```

## Lancement local

```bash
node --max-old-space-size=4096 scripts/ml/build-dataset.mjs   # ~10-20 min
pip install -r scripts/ml/requirements.txt
python scripts/ml/train.py                                    # ~5-15 min
python scripts/ml/export-thresholds.py                        # quelques sec
```

## Lancement CI

Workflow `.github/workflows/ml-train.yml` (dispatch manuel via UI GH Actions).
Tourne en ~30-60 min sur runner ubuntu-latest free tier.

## Features (19)

| Catégorie | Features |
|-----------|----------|
| Momentum  | rsi, macd_line, macd_signal, macd_hist, chg5, chg20 |
| Trend     | ma20_rel, ma50_rel, ma200_rel, ma50_slope, ichi_pos, ichi_sig, regime |
| Volatilité | atr_pct, vol20, boll_pos |
| Force     | adx, stoch_k, stoch_d |

## Labels (3 horizons)

Pour chaque jour D, on simule un trade LONG entry=close[D] :
- `label_day`   : stop -1×ATR vs cible +4×ATR sur 7 jours
- `label_week`  : stop -1×ATR vs cible +5×ATR sur 21 jours
- `label_month` : stop -1×ATR vs cible +7×ATR sur 60 jours

Valeurs : +1 (win), -1 (loss), 0 (timeout).

## Consumer (build-ai-study.mjs)

À terme : lit `data/ml/rules.json` (si présent), récupère la prob ML
du setup courant, et boost/cap le `quality_score` v3.4 en conséquence.
Tant que rules.json n'existe pas, comportement v3.4 inchangé (fallback safe).

## Artifacts gitignorés

`dataset.csv` (~80 MB), `model_*.json` binaires XGBoost. Seuls
`rules.json` et `metrics.json` sont commit (légers, audit-friendly).
