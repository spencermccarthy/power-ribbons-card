# Power Ribbons Card

A Home Assistant dashboard card that shows where your power came from and where it went today.

You get one ribbon per **source** (for example Solar, Grid and Battery), each centred on its own line:

- **Thickness** is how much power that source was supplying at the time.
- **Colour** is where the power went (for example House, Battery or Grid export). When a source feeds more than one place, its ribbon is split into coloured layers.

All the ribbons share one timeline, from midnight to now, and they all use the same scale, so you can compare thicknesses directly. Hover over (or tap) the chart to see the breakdown for any 10-minute block.

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
| `opacity` | `0.85` | How opaque the layers are |
| `max_kw` | auto | Fixes the scale. By default it scales to the biggest source today |
| `min_scale_kw` | `1` | Smallest scale to use when auto-scaling, so quiet days don't look huge |
| `label_width` | `64` | Width in px of the space on the left for source names |
| `legend_text` | built-in | Text shown before the colour key. Use `""` to hide it |

## Licence

MIT
