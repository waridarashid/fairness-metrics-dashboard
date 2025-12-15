from pathlib import Path
import re  
from flask import Flask, request, jsonify
import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import OneHotEncoder
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import confusion_matrix, accuracy_score

CSV_PATH = Path("german_credit_with_split.csv")
TARGET_COLUMN = "CreditRisk"

PROTECTED_ATTRS = {
    "gender"        : "Gender",
    "marital_status": "Marital_status",
    "age"           : "Age"
}

app = Flask(__name__, static_folder="static")
df = pd.read_csv(CSV_PATH)

# ---- 2. TRAIN / PREDICT ----------------------------------
y = df[TARGET_COLUMN].map({2:0, 1:1}) 
X = df.drop(columns=[TARGET_COLUMN])

cat_cols = X.select_dtypes(include="object").columns.tolist()

prep = ColumnTransformer(
    transformers=[("cat", OneHotEncoder(handle_unknown="ignore"), cat_cols)],
    remainder="passthrough"
)

clf = Pipeline([
    ("prep", prep),
    ("logreg", LogisticRegression(max_iter=300, solver="liblinear", class_weight="balanced"))
])

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.3, stratify=y, random_state=42
)

# Reset indices to avoid misalignment
X_train.reset_index(drop=True, inplace=True)
X_test.reset_index(drop=True, inplace=True)
y_train.reset_index(drop=True, inplace=True)
y_test.reset_index(drop=True, inplace=True)

clf.fit(X_train, y_train)
y_pred = clf.predict(X_test)
y_prob = clf.predict_proba(X_test)[:, 1]

# For app use
proba_test = y_prob

# Debug log for validation
print("Confusion matrix:")
print(confusion_matrix(y_test, y_pred))
print("Accuracy:", round(accuracy_score(y_test, y_pred), 4))

def bucket_age(series):
    bins = [0, 30, series.max() + 1]
    labels = ["<30", "≥30"]
    return pd.cut(series, bins=bins, labels=labels, right=False)

def confusion_by_mask(mask, thr):
    if mask.sum() == 0:
        return dict(TP=0, FP=0, TN=0, FN=0)

    idx = mask.values            #  ← NEW  (pure boolean array)

    y_true = y_test[idx].values
    y_pred_bin = (y_prob[idx] >= thr).astype(int)  # ← use idx

    tn, fp, fn, tp = confusion_matrix(
        y_true, y_pred_bin, labels=[0, 1]
    ).ravel()

    return dict(TP=int(tp), FP=int(fp), TN=int(tn), FN=int(fn))

def _as_cat(series: pd.Series) -> pd.Series:
    """Return a tidy, categorical string version suitable for the Sankey."""
    name = series.name.lower()

    # numeric Age → buckets <30, 30–49, 50+
    if name == "age" and pd.api.types.is_numeric_dtype(series):
        return bucket_age(series).astype(str)

    # normalise capitalisation for consistency
    if name == "gender":
        return series.str.capitalize()         # male → Male
    if name == "marital_status":
        return series.str.title()              # single → Single

    # fall-back
    return series.astype(str)



# ------------------------------------------------------------------ #
#  Fairness‑gap helper used by LOGO                                   #
# ------------------------------------------------------------------ #
def _gap_for_df(df_eval: pd.DataFrame, metric: str) -> float:
    """Return max–min disparity of `metric` across the groups in *df_eval*."""
    def ratio(sub):
        tp = ((sub["gt"] == 1) & (sub["pred"] == 1)).sum() 
        fp = ((sub["gt"] == 0) & (sub["pred"] == 1)).sum() 
        tn = ((sub["gt"] == 0) & (sub["pred"] == 0)).sum() 
        fn = ((sub["gt"] == 1) & (sub["pred"] == 0)).sum()

        if metric == "demographic_parity":       return (tp+fp)/(tp+fp+tn+fn) if (tp+fp+tn+fn) else np.nan
        if metric == "equal_opportunity":        return tp/(tp+fn)            if (tp+fn)       else np.nan
        if metric == "predictive_parity":        return tp/(tp+fp)            if (tp+fp)       else np.nan
        if metric == "predictive_equality":      return fp/(fp+tn)            if (fp+tn)       else np.nan
        if metric == "treatment_equality":       return fn/fp                 if fp            else np.nan
        if metric == "equalized_odds":
            tpr = tp/(tp+fn) if (tp+fn) else np.nan
            fpr = fp/(fp+tn) if (fp+tn) else np.nan
            return abs(tpr-fpr) if not (np.isnan(tpr)|np.isnan(fpr)) else np.nan
        return np.nan

    vals = (df_eval
            .groupby("group", dropna=False)
            .apply(ratio)
            .dropna()
            .values)
    return 0.0 if len(vals) < 2 else float(np.nanmax(vals) - np.nanmin(vals))

def ordered_age_labels(series):
    """Return the distinct age-bucket strings sorted by their
       numeric lower-bound (e.g. '<30', '30–49', '50+')."""
    def key(label):
        # pull first number in the string; '<30' → 0, '30–49' → 30, '50+' → 50
        m = re.search(r"\d+", label)
        return int(m.group()) if m else 0
    return sorted(series.unique(), key=key)

def build_sankey_json(protected_cols, thr, metric):
    """
    3-layer Sankey:
        L0: GT+ , GT−
        L1: protected groups
        L2: TP / FP / TN / FN
    Node sizes: counts. Group→Outcome link tooltip uses within-group share.
    """
    df_eval = X_test.copy()
    df_eval["gt"]   = y_test.values
    df_eval["pred"] = (y_prob >= thr).astype(int)

    node_map, nodes, links = {}, [], []

    def node_id(label):
        if label not in node_map:
            node_map[label] = len(nodes)
            nodes.append({"name": label})
        return node_map[label]

    # L0
    gt_pos = node_id("GT+")
    gt_neg = node_id("GT-")

    # L1
    if not protected_cols:
        df_eval["group"] = "All"
    else:
        cols_real = [PROTECTED_ATTRS[c] for c in protected_cols]
        if len(cols_real) == 1:
            col = cols_real[0]
            df_eval["group"] = _as_cat(df_eval[col])
            if col.lower() == "age":
                ordered = ordered_age_labels(df_eval["group"])
                cat_type = pd.CategoricalDtype(categories=ordered, ordered=True)
                df_eval["group"] = df_eval["group"].astype(cat_type)
        else:
            c1, c2 = cols_real
            df_eval["group"] = _as_cat(df_eval[c1]) + " | " + _as_cat(df_eval[c2])

    group_ids = {g: node_id(g) for g in df_eval["group"].unique()}

    # GT → Group (counts)
    for g, sub in df_eval.groupby("group"):
        gid = group_ids[g]
        pos = int((sub["gt"] == 1).sum())
        neg = int((sub["gt"] == 0).sum())
        tot = pos + neg or 1

        # attach shares on the *group node* (so you can also use them for node fills)
        nodes[gid]["gt_pos_share"] = pos / tot
        nodes[gid]["gt_neg_share"] = neg / tot

        links.append({"source": gt_pos, "target": gid, "value": pos, "value": pos, "share": pos / tot})
        links.append({"source": gt_neg, "target": gid, "value": neg, "value": neg, "share": neg / tot})

    # L2 outcome nodes
    out_tp = node_id("TP")
    out_fp = node_id("FP")
    out_tn = node_id("TN")
    out_fn = node_id("FN")

    # Group → Outcome (counts + share, NO derivatives)
    for g, sub in df_eval.groupby("group"):
        gid = group_ids[g]
        tp = ((sub["gt"]==1)&(sub["pred"]==1)).sum()
        fp = ((sub["gt"]==0)&(sub["pred"]==1)).sum()
        tn = ((sub["gt"]==0)&(sub["pred"]==0)).sum()
        fn = ((sub["gt"]==1)&(sub["pred"]==0)).sum()
        total = tp+fp+tn+fn or 1

        tpr = tp / (tp + fn) if (tp + fn) else None
        fpr = fp / (fp + tn) if (fp + tn) else None
        tnr = tn / (tn + fp) if (tn + fp) else None
        fnr = fn / (fn + tp) if (fn + tp) else None

        def add(src, tgt, val, extra=None):
            link = {
                "source": src, "target": tgt,
                "value": int(val),
                "share": (val / total) if total else 0.0
            }
            if extra: link.update(extra)
            links.append(link)

        add(gid, out_tp, tp, {"rate_tpr": None if tpr is None else float(tpr)})
        add(gid, out_fp, fp, {"rate_fpr": None if fpr is None else float(fpr)})
        add(gid, out_tn, tn, {"rate_tnr": None if tnr is None else float(tnr)})
        add(gid, out_fn, fn, {"rate_fnr": None if fnr is None else float(fnr)})

    return {"nodes": nodes, "links": links}


def metric_gap(metric: str, thr: float, protected_cols: list[str]) -> float:
    """
    Compute disparity (max - min) of 'metric' across the chosen protected groups.
    Supported metrics: equal_opportunity, predictive_parity,
                       predictive_equality, equalized_odds
    """
    if not protected_cols:
        return 0.0

    # Resolve real column names
    col_map = [PROTECTED_ATTRS[c] for c in protected_cols]

    # Slice X_test (already aligned) and add pred / label columns
    df_eval = X_test[col_map].copy()

    # ── Bucket Age if it is in the slice (so groups are categorical) ──
    if "Age" in df_eval.columns and pd.api.types.is_numeric_dtype(df_eval["Age"]):
        df_eval["Age"] = bucket_age(df_eval["Age"])

    df_eval["pred"]  = (y_prob >= thr).astype(int)
    df_eval["label"] = y_test.values

    # ── Metric definition per group ───────────────────────────────────
    def ratio(d: pd.DataFrame) -> float:
        tp = ((d.label == 1) & (d.pred == 1)).sum()
        fp = ((d.label == 0) & (d.pred == 1)).sum()
        tn = ((d.label == 0) & (d.pred == 0)).sum()
        fn = ((d.label == 1) & (d.pred == 0)).sum()

        if metric == "demographic_parity":       
            total = tp + fp + tn + fn
            return np.nan if total == 0 else (tp + fp) / total

        if metric == "equal_opportunity":           # True-Positive Rate
            denom = tp + fn
            return np.nan if denom == 0 else tp / denom

        if metric == "predictive_parity":           # Precision
            denom = tp + fp
            return np.nan if denom == 0 else tp / denom

        if metric == "predictive_equality":         # False-Positive Rate
            denom = fp + tn
            return np.nan if denom == 0 else fp / denom

        if metric == "equalized_odds":              # |TPR − FPR|
            tpr = tp / (tp + fn) if (tp + fn) else np.nan
            fpr = fp / (fp + tn) if (fp + tn) else np.nan
            return np.nan if np.isnan(tpr) or np.isnan(fpr) else abs(tpr - fpr)
        
        if metric == "treatment_equality":
            return fn / fp if fp > 0 else np.nan

        return np.nan   # unsupported metric

    # ── Compute ratio per group, drop NaNs, then gap = max − min ─────
    group_vals = (
        df_eval
          .groupby(col_map, dropna=False)
          .apply(ratio)
          .dropna()
          .values
    )

    return 0.0 if len(group_vals) == 0 else float(np.nanmax(group_vals) - np.nanmin(group_vals))

@app.route("/")
def root():
    return app.send_static_file("index.html")

# @app.route("/sankey")
# def sankey_route():
#     protected = request.args.get("protected", "")
#     thr = float(request.args.get("thr", 0.5))
#     cols = [c.strip() for c in protected.split(",") if c.strip()]
#     return jsonify(build_sankey_json(cols, thr))

@app.route("/sankey")
def sankey_route():
    """Return Sankey JSON + signed‑pull contribution per group node."""
    protected = request.args.get("protected", "")
    thr       = float(request.args.get("thr", 0.5))
    metric    = request.args.get("metric", "equal_opportunity")
    cols      = [c.strip() for c in protected.split(",") if c.strip()]

    # ---------- 1.  Plain Sankey (nodes + links) ----------------------
    sankey_json = build_sankey_json(cols, thr, metric)

    # ---------- 2.  Build evaluation frame ---------------------------
    df_eval = X_test.copy()
    df_eval["gt"]   = y_test.values
    df_eval["pred"] = (y_prob >= thr).astype(int)

    if not cols:
        df_eval["group"] = "All"
    else:
        real = [PROTECTED_ATTRS[c] for c in cols]
        if len(real) == 1:
            df_eval["group"] = _as_cat(df_eval[real[0]])
        else:
            df_eval["group"] = _as_cat(df_eval[real[0]]) + " | " + _as_cat(df_eval[real[1]])

    # ---------- 3.  Signed‑pull contribution -------------------------
    def metric_ratio(sub):
        tp = ((sub["gt"]==1)&(sub["pred"]==1)).sum()
        fp = ((sub["gt"]==0)&(sub["pred"]==1)).sum()
        tn = ((sub["gt"]==0)&(sub["pred"]==0)).sum()
        fn = ((sub["gt"]==1)&(sub["pred"]==0)).sum()

        if metric == "demographic_parity":  return (tp+fp)/(tp+fp+tn+fn) if tp+fp+tn+fn else np.nan
        if metric == "equal_opportunity":   return tp/(tp+fn)            if tp+fn       else np.nan
        if metric == "predictive_parity":   return tp/(tp+fp)            if tp+fp       else np.nan
        if metric == "predictive_equality": return fp/(fp+tn)            if fp+tn       else np.nan
        if metric == "treatment_equality":  return fn/fp                 if fp          else np.nan
        if metric == "equalized_odds":
            tpr = tp/(tp+fn) if tp+fn else np.nan
            fpr = fp/(fp+tn) if fp+tn else np.nan
            return abs(tpr-fpr) if not (np.isnan(tpr)|np.isnan(fpr)) else np.nan
        return np.nan
    
    

    metric_vals = (
        df_eval.groupby("group", dropna=False)
               .apply(metric_ratio)
               .dropna()
    )
    metric_map = metric_vals.to_dict()
    for n in sankey_json["nodes"]:
        name = n.get("name")
        if name in metric_map:
            n["metric_val"] = float(metric_map[name])

    overall_val = metric_vals.mean()                 # baseline
    contrib = {}
    for g, val in metric_vals.items():
        pop = len(df_eval[df_eval["group"] == g])
        contrib[g] = (val - overall_val) * pop       # signed pull

    # attach to nodes
    for n in sankey_json["nodes"]:
        g = n["name"]
        if g in metric_vals:
            n["metric_val"] = float(metric_vals[g])

    # ---------- 4.  Return JSON --------------------------------------
    return jsonify(sankey_json)


@app.route("/metric_gap")
def gap_route():
    metric = request.args.get("metric", "equal_opportunity")
    thr = float(request.args.get("thr", 0.5))
    protected = [c.strip() for c in request.args.get("protected", "").split(",") if c.strip()]
    g = metric_gap(metric, thr, protected)
    return jsonify(dict(metric=metric, gap=round(g, 4)))

@app.errorhandler(Exception)
def handle_exception(e):
    import traceback, sys
    traceback.print_exc(file=sys.stdout)
    return jsonify(error=str(e)), 500

@app.route("/heatmap")
def heatmap_api():
    metric   = request.args["metric"]
    feature  = request.args["feature"]
    bins     = int(request.args.get("bins", 6))
    thr      = float(request.args.get("thr", .5))
    component  = request.args.get("component", "tpr")  # NEW 'tpr' or 'fpr'

    # 0.  sanity-check
    if feature not in X_test.columns:
        return jsonify(error=f"feature '{feature}' not found"), 400

    prot_param = request.args.get("prot", "age")
    current_protected = [p for p in prot_param.split(",") if p]

    df = X_test.copy()
    df["label"] = y_test.values
    df["pred"]  = (y_prob >= thr).astype(int)

    # 1.  generate fbin labels  ---------------------------------------
    if pd.api.types.is_numeric_dtype(df[feature]):

        # equal-population edges, duplicates collapsed
        edges  = np.unique(
            np.quantile(df[feature], np.linspace(0, 1, bins + 1))
        )
        labels = [f"{int(edges[i])}–{int(edges[i+1])}"
                for i in range(len(edges) - 1)]

        # build an *ordered* Categorical so groupby keeps this order
        cat_type = pd.CategoricalDtype(categories=labels, ordered=True)
        df["fbin"] = pd.cut(
            df[feature],
            bins=edges,
            labels=labels,
            include_lowest=True,
            duplicates="drop"
        ).astype(cat_type)
    else:
        df["fbin"] = df[feature].astype(str)

    # 2.  build pgroup  ----------------------------------------------
    col_map = [PROTECTED_ATTRS[c] for c in current_protected if c]

    if not col_map:
        df["pgroup"] = "All"

    elif len(col_map) == 1:
        col = col_map[0]
        if col.lower() == "age" and pd.api.types.is_numeric_dtype(df[col]):
            df["pgroup"] = bucket_age(df[col]).astype(str)
        else:
            df["pgroup"] = df[col].astype(str)

    else:  # intersection of two protected attributes  ★ FIX ★
        col1, col2 = col_map
        def as_cat(s):
            if s.name.lower() == "age" and pd.api.types.is_numeric_dtype(s):
                return bucket_age(s).astype(str)
            return s.astype(str)
        df["pgroup"] = as_cat(df[col1]) + " | " + as_cat(df[col2])
        

    # ── metric value per (pgroup, fbin) ────────────────────
    def fair_ratio(sub):
        tp = ((sub.label==1)&(sub.pred==1)).sum()
        fp = ((sub.label==0)&(sub.pred==1)).sum()
        tn = ((sub.label==0)&(sub.pred==0)).sum()
        fn = ((sub.label==1)&(sub.pred==0)).sum()

        if metric == "equal_opportunity":   return tp/(tp+fn) if tp+fn else np.nan
        if metric == "predictive_parity":   return tp/(tp+fp) if tp+fp else np.nan
        if metric == "predictive_equality": return fp/(fp+tn) if fp+tn else np.nan
        if metric == "demographic_parity":  return (tp+fp)/(tp+fp+tn+fn)
        if metric == "treatment_equality":  return fn/fp if fp else np.nan
        if metric == "equalized_odds":     
            if component == "tpr":
                return tp/(tp+fn) if tp+fn else np.nan
            else:  # 'fpr'
                return fp/(fp+tn) if fp+tn else np.nan
        return np.nan

    mat = (df
            .groupby(["pgroup", "fbin"])
            .apply(fair_ratio)
            .unstack("pgroup"))

    # convert every numeric value to float, NaN → None (=> null in JSON)
    value_grid = [
        [None if pd.isna(v) else float(v) for v in row]
        for row in mat.values
    ]

    return jsonify(
        rows   = [str(r) for r in mat.index],
        cols   = list(mat.columns),
        values = value_grid
    )

@app.route("/feature_list")
def feature_list():
    """Return every original column in X_test so the front-end knows what's valid."""
    return jsonify(list(X_test.columns))

@app.route("/pcp_data")
def pcp_data():
    """Return row-wise data for the parallel-coordinates plot."""
    thr = float(request.args.get("thr", 0.5))

    df = X_test.copy()

    # columns used for PCP
    # (keep original numeric cols; keep object/string as categoricals)
    num_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    cat_cols = [c for c in df.columns if c not in num_cols]

    # add target/prediction/score
    df["true_label"] = y_test.values.astype(int)
    df["prediction"] = (y_prob >= thr).astype(int)
    df["score"]      = y_prob.astype(float)

    # make categoricals JSON-friendly
    for c in cat_cols:
        df[c] = df[c].astype(str).fillna("NA")

    # OPTIONAL: don’t send everything if your dataset is large
    # df = df.sample(n=min(len(df), 1500), random_state=0)

    return jsonify(
        data=df.to_dict(orient="records"),
        numericKeys=[c for c in num_cols + ["score"] if c in df.columns],
        catKeys=[c for c in cat_cols if c in df.columns]
    )


@app.route("/repredict", methods=["POST"])
def repredict():
    """
    Re-run predictions on neutralized data.
    Receives a list of data rows with potentially modified feature values.
    Returns new prediction scores.
    """
    try:
        data = request.get_json()
        rows = data.get("rows", [])

        if not rows:
            return jsonify({"error": "No rows provided"}), 400

        # Convert to DataFrame
        df_neutral = pd.DataFrame(rows)

        # Extract only the feature columns (exclude target, prediction, score, etc.)
        feature_cols = X_test.columns.tolist()
        df_features = df_neutral[feature_cols]

        # Get new predictions from the trained model
        new_proba = clf.predict_proba(df_features)[:, 1]

        # Return as list
        return jsonify({
            "scores": new_proba.tolist()
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=True, port=5000)
