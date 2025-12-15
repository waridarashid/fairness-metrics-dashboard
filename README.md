# Fairness Metrics Visualization Dashboard

An interactive web-based dashboard for visualizing and analyzing fairness metrics in machine learning classification models. This tool helps identify and understand bias across different demographic groups through multiple coordinated visualization techniques.

## Overview

This dashboard provides a comprehensive visual analysis system for exploring fairness in ML model predictions. It features interactive visualizations including confusion matrix distributions, parallel coordinate plots, metric scores, and score distributions that work together to reveal patterns of bias and discrimination.

## Features

### Interactive Visualizations

- **Confusion Matrix Distribution**: Center-anchored bar charts showing TP/FP/TN/FN distributions across protected groups
- **Parallel Coordinates Plot (PCP)**: Multi-dimensional feature explorer with brushing and filtering capabilities
- **Metric Scores**: Comparative bar charts displaying fairness metric values across groups
- **Score Distribution**: Grouped bar charts showing score distributions by feature buckets

### Fairness Metrics

- **Equal Opportunity (TPR)**: Measures equal true positive rates across groups
- **Predictive Parity (PPV)**: Ensures positive predictions are equally accurate
- **Predictive Equality (FPR)**: Measures equal false positive rates
- **Demographic Parity (PPR)**: Ensures equal positive prediction rates
- **Equalized Odds**: Requires both equal TPR and FPR
- **Treatment Equality**: Measures ratio of FN to FP errors

### Key Capabilities

- **Metric Highlighting**: Visual indicators showing numerator/denominator components in confusion bars
- **Selection Hierarchy**: Coordinated filtering between confusion bars and score distributions
- **Brushing & Filtering**: Interactive selection in PCP with real-time updates
- **Neutralization Analysis**: Compare original vs. neutralized model predictions
- **Statistical Significance**: Permutation tests to identify significant features.

## Project Structure

```
New Fairness/
├── static/
│   ├── index.html          # Main HTML structure
│   ├── script.js           # Core visualization logic (~5,500+ lines)
│   ├── styles.css          # Styling and animations
│   └── data/               # CSV data files (if applicable)
├── server.py               # Flask backend server
└── README.md               # This file
```

## File Descriptions

### `index.html`
The main HTML structure containing:
- Control panel with metric/group selection
- Multiple visualization containers
- Interactive buttons and UI elements

### `script.js`
Core application logic organized into sections:

1. **State Management** (lines ~210-220)
   - `currentMetric`: Selected fairness metric
   - `currentProtected`: Selected protected attributes
   - `currentThr`: Classification threshold
   - `window.streamSelections`: Active filters and selections

2. **Data Processing** (lines ~277-400)
   - `updateAll()`: Main data fetching and rendering pipeline
   - `computeConfusionBarData()`: Aggregates confusion matrix statistics
   - `rowMatchesGroup()`: Group membership testing

3. **Confusion Bars** (lines ~898-1800)
   - `drawConfusionBars()`: Renders confusion matrix distribution
   - `updateConfusionBarStyles()`: Updates visual styling based on selections
   - `handleSegmentClick()`: Manages bar click interactions
   - Three-level opacity system: numerator (1.0), denominator-only (0.6), rest (0.3)

4. **Parallel Coordinates Plot** (lines ~2500-3600)
   - `renderPCP()`: Main PCP rendering with D3.js
   - Supports brushing, axis reordering, and neutralization overlays
   - Multiple layers: background, foreground, streams, outcomes, context

5. **Feature Distribution** (lines ~5900-6500)
   - `updateFeatureDistribution()`: Renders score distribution charts
   - `handleDistributionBarClick()`: Click handler for distribution bars
   - Grouped bar charts with feature bucketing

6. **Metric Calculations** (lines ~1967-2015)
   - `metricNumerator()`: Returns metric numerator components
   - `metricDenominator()`: Returns metric denominator components
   - Used for visual highlighting and equation display

7. **Neutralization** (lines ~5219-5500)
   - Feature neutralization implementation
   - Quantile mapping for distribution matching
   - Before/after comparison overlays

### `styles.css`
Styling includes:
- Panel layouts and responsive design
- Metric highlighting with colored borders and shadows
- Smooth transitions (0.8s opacity fade)
- Interactive states (hover, active, dimmed)

### `server.py`
Flask backend that:
- Serves static files
- Provides API endpoints for data fetching
- Handles neutralization computations
- Runs permutation tests for significance

## How It Works

### Data Flow

1. **Initialization**
   ```
   User loads page → updateAll() → Fetch data from API → Render all visualizations
   ```

2. **Metric Selection**
   ```
   User selects metric → updateMetricEquation() →
   Update confusion bar highlighting →
   Apply 3-level opacity (numerator/denominator/rest) →
   Smooth fade transition (0.8s)
   ```

3. **Interactive Filtering**
   ```
   User clicks confusion bar → Store in streamSelections →
   Filter PCP to show subset →
   Update feature distributions
   ```

4. **Brushing in PCP**
   ```
   User brushes axes → Store brush ranges in pcpBrush →
   Filter visible data →
   Update confusion bars with filtered subset →
   Update metric scores
   ```

### Selection Hierarchy

The dashboard implements a two-tier selection system:

1. **Confusion Bar Selections** (outcome-based)
   - Clicking confusion bars filters by outcome and group
   - Higher priority - clears distribution selections when clicked

2. **Distribution Bar Selections** (feature-based)
   - Clicking distribution bars filters by feature values
   - Lower priority - filtered within existing confusion selections
   - Shows intersection of both when both are active

### Visual Highlighting System

When a metric is selected, confusion bar segments are highlighted:

- **Numerator segments**: Green border (6px), full opacity (1.0), subtle shadow
- **Denominator-only segments**: Amber border (6px), medium opacity (0.6), subtle shadow
- **Non-metric segments**: No border, low opacity (0.3)
- **Transition**: Smooth 0.8s ease-in-out fade

### Color Coding

- **Outcomes**: TP (green), FP (red), TN (blue), FN (purple)
- **Protected Groups**: Categorical color scale (contrasting palette)
- **Metric Borders**: Numerator (green #10b981), Denominator (amber #f59e0b)

## API Endpoints

### `POST /api/data`
Fetches preprocessed data for visualization.

**Request:**
```json
{
  "protected": ["age"],
  "threshold": 0.5
}
```

**Response:**
```json
{
  "data": [...],  // Array of prediction records
  "protected_attrs": ["age"],
  "feature_names": [...]
}
```

### `POST /api/neutralize`
Performs feature neutralization.

**Request:**
```json
{
  "protected": ["age"],
  "threshold": 0.5,
  "features": ["feature1", "feature2"]
}
```

**Response:**
```json
{
  "data": [...],  // Neutralized data
  "original_data": [...]  // Original data for comparison
}
```

## Technologies Used

- **D3.js v7**: Data visualization and SVG manipulation
- **Flask**: Python backend server
- **NumPy/Pandas**: Data processing and statistical computations
- **HTML5/CSS3**: Modern web standards
- **ES6 JavaScript**: Modern JavaScript features

## Key Interactions

### Reset Buttons
- **PCP Reset** (↻): Clears all brush filters
- **Confusion Reset** (↻): Clears confusion bar selections only
- **Distribution Reset** (↻): Clears distribution bar selections only
- **Metric Clear**: Deselects current metric

### Tooltips & Help
- Hover over bars for detailed counts and percentages
- Click **?** button next to metric equation for definition

## Usage Example

1. **Select a Metric**: Choose a fairness metric (e.g., Equal Opportunity)
2. **Observe Highlighting**: Confusion bars highlight numerator/denominator components
3. **Click to Filter**: Click confusion bar segments to filter specific outcomes
4. **Brush PCP**: Drag on PCP axes to filter by feature ranges
5. **Analyze Distribution**: View score distributions for filtered subsets
6. **Compare Groups**: Examine metric scores across protected groups
7. **Reset as Needed**: Use reset buttons to clear filters independently

## Performance Considerations

- **Data Limits**: Stream selections limited to 500 random samples for performance
- **Transitions**: CSS transitions used for smooth animations (0.8s opacity)
- **Rendering**: Efficient D3.js update patterns with data joins
- **Caching**: Window-level state caching for selections and filters

## Browser Compatibility

- Modern browsers with ES6 support
- Chrome/Edge (recommended)
- Firefox
- Safari

## Development Setup

1. Install Python dependencies:
   ```bash
   pip install flask pandas numpy scikit-learn
   ```

2. Run the Flask server:
   ```bash
   python server.py
   ```

3. Open browser to `http://localhost:5000`



