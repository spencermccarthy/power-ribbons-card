# Power Ribbons Card

A Home Assistant dashboard card that shows where your power came from and where it went today.

You get one ribbon per **source** (for example Solar, Grid and Battery), each centred on its own line:

- **Thickness** is how much power that source was supplying at the time.
- **Colour** is where the power went (for example House, Battery or Grid export).

There are two layouts:

- **`overlap`** (default): each destination gets its own ribbon, centred on the source's line, as thick as the power that went there. Fills are see-through with a solid outline, so you can see one ribbon through another and a big battery charge doesn't push the others outwards.
- **`stack`**: a source's destinations are stacked into one solid ribbon, so its total thickness is everything that source supplied.

All the ribbons share one timeline, from midnight to now, and they all use the same scale, so you can compare thicknesses directly. Hover over (or tap) the chart to see the breakdown for any 10-minute block.

Tabs across the top (**All**, then one per source) switch to a detail view for a single source, styled after the Predbat Card solar chart:

- **Above the axis:** the **forecast** as a smooth line with a fading fill, and the **actual** as bars (average kW per 30 minutes). Earlier parts of the day are lightly shaded, and  is marked along with the forecast value at that moment.
  - **Solar** uses a Solcast-style detailed forecast (, e.g. Predbat's ): the calibrated forecast, the 10–90% band, and the forecast *before calibration* as a dashed line.
  - **Grid / Battery** use the **plan as it stood at 00:00** (read back from HA history), plus the **latest plan** for the rest of today as a dashed line.
- **Below the axis:** the same bars mirrored downwards, split by **where the power went**, on the same kW scale. After now, dashed faded bars show the forecast split.
- **Legend:** forecast total, actual vs forecast so far (%), what's left today, and what has gone to each destination so far.

### Forecast (Predbat)

```yaml
forecast:
  solar_detail: sensor.predbat_pv_today  # 30-min Solcast-style forecast (optional, solar tab)
  solar: predbat.pv_power_best        # kW plan in the "results" attribute
  grid: predbat.grid_power_best       # + import / - export
  battery: predbat.battery_power_best # + discharge / - charge
```

A source uses the plan whose key matches its name in lowercase (`Solar`, `Grid`, `Battery`), or whatever you set with `role:`. Predbat doesn't publish where its planned power goes, so the card **estimates** the split by destination from the solar, grid and battery plans. It uses the usual inverter priority: solar goes to the house first, then the battery, then export; battery goes to the house, then export; grid goes to the house, then the battery. That estimate needs all three plans. Any other forecast entity whose attribute holds `{timestamp: kW}` also works (`forecast.attribute`, which defaults to `results`).

No other cards or libraries are needed. The card reads Home Assistant's recorder history directly.

## Install (HACS)

1. In HACS, open the menu (⋮), choose **Custom repositories**, add `https://github.com/spencermccarthy/power-ribbons-card`, and pick type **Dashboard**.
2. Install **Power Ribbons Card**, then reload the browser.

## Configuration

You need a sensor for each flow, reporting power in W or kW. GivEnergy (GivTCP) provides these as `*_solar_to_house`, `*_grid_to_battery` and so on. Other inverters can use template sensors.

```yaml
type: custom:power-ribbons-card
title: Where power came from and went today
destinations:
  house: { name: House }            # colours default to house=orange, battery=green, grid=blue
  battery: { name: Battery }
  grid: { name: Grid (export) }
sources:
  - name: Solar
    flows:
      - { entity: sensor.solar_to_house, to: house }
      - { entity: sensor.solar_to_battery, to: battery }
      - { entity: sensor.solar_to_grid, to: grid }
  - name: Grid
    flows:
      - { entity: sensor.grid_to_house, to: house }
      - { entity: sensor.grid_to_battery, to: battery }
  - name: Battery
    flows:
      - { entity: sensor.battery_to_house, to: house }
      - { entity: sensor.battery_to_grid, to: grid }
```

| Option | Default | What it does |
|---|---|---|
| `title` | none | Card heading |
| `sources` | **required** | Ribbons from top to bottom. Each one has a `name` and its `flows` (`entity`, plus `to`, the destination key) |
| `destinations` | from the flows | The `name` and `color` for each destination key |
| `height` | `200` | Height of the chart in px |
| `bin_minutes` | `10` | Averaging period for each point |
| `refresh_minutes` | `5` | How often history is fetched again |
| `mode` | `overlap` | `overlap` or `stack` (see above) |
| `tabs` | `true` | Shows the All and per-source tabs |
| `forecast` | none | Plan entities (see above) |
| `detail_height` | `300` | Chart height in px on the source tabs |
| `period_minutes` | `30` | Bar period on the source tabs |
| `actual_color` | `#2bb673` | Colour of the actual bars |
| `sources[].color` | by role | Line colour on that source's tab |
| `sources[].role` | from name | `solar`, `grid` or `battery`, to match the forecast |
| `all_label` | `All` | Label for the overview tab |
| `fill_opacity` | `0.35` | Strongest fill opacity, which fades towards the edges |
| `stroke_width` | `2` | Outline width in `overlap` mode |
| `opacity` | `0.85` | Fill opacity in `stack` mode |
| `max_kw` | auto | Fixes the scale. By default it scales to the biggest ribbon today |
| `min_scale_kw` | `1` | Smallest scale to use when auto-scaling, so quiet days don't look huge |
| `label_width` | `64` | Width in px of the space on the left for source names |
| `legend_text` | built-in | Text shown before the colour key. Use `""` to hide it |

## Credits

The visual style (section header, pill tabs, fading area fills and tooltip) is modelled on [Predbat Card](https://github.com/mimikm/Predbat-Card) by mimikm (MIT).

## Licence

MIT
