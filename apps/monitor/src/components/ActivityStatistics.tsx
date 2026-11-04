import { useState } from "react";
import {
  emptyNight,
  latestNightKey,
  NIGHT_HOURS,
  previousNights,
  type ActivityState,
} from "../services/activity";

export function ActivityStatistics({ activity }: { activity: ActivityState }) {
  const [selected, setSelected] = useState(latestNightKey);
  const night = activity.nights[selected] ?? emptyNight();
  const maximum = Math.max(
    1,
    ...night.hours.map((hour) => Math.max(hour.motion, hour.sound)),
  );
  return (
    <section className="content-screen" aria-labelledby="statistics-title">
      <div className="screen-heading">
        <div>
          <p className="eyebrow">NIGHT ACTIVITY</p>
          <h2 id="statistics-title">Statistics</h2>
          <p>Received movement and sound events, night by night.</p>
        </div>
      </div>
      <label className="night-picker">
        Night starting{" "}
        <input
          type="date"
          value={selected}
          onChange={(event) => {
            if (previousNights(event.target.value).length)
              setSelected(event.target.value);
          }}
        />
      </label>
      <p className="screen-footnote">
        18:00–08:00, this device’s local time (
        {Intl.DateTimeFormat().resolvedOptions().timeZone}). Daytime events
        remain in Events.
      </p>
      <div className="statistics-grid activity-totals">
        <div className="stat-tile">
          <p>Movement events</p>
          <strong>{night.motion}</strong>
        </div>
        <div className="stat-tile">
          <p>Sound events</p>
          <strong>{night.sound}</strong>
        </div>
      </div>
      <div className="activity-chart">
        <div className="chart-legend">
          <span className="motion-key">● Movement</span>
          <span className="sound-key">● Sound</span>
        </div>
        <svg
          viewBox="0 0 740 245"
          role="img"
          aria-label={`Hourly movement and sound events for the night starting ${selected}`}
        >
          <line x1="35" y1="200" x2="730" y2="200" stroke="#41445c" />
          {night.hours.map((hour, index) => (
            <g key={index}>
              <rect
                x={43 + index * 49}
                y={200 - (hour.motion / maximum) * 160}
                width="15"
                height={(hour.motion / maximum) * 160}
                rx="3"
                fill="#a276ff"
              >
                <title>
                  {NIGHT_HOURS[index]}:00 movement: {hour.motion}
                </title>
              </rect>
              <rect
                x={61 + index * 49}
                y={200 - (hour.sound / maximum) * 160}
                width="15"
                height={(hour.sound / maximum) * 160}
                rx="3"
                fill="#68d6b0"
              >
                <title>
                  {NIGHT_HOURS[index]}:00 sound: {hour.sound}
                </title>
              </rect>
              <text
                x={58 + index * 49}
                y="226"
                fill="#a3a7c4"
                fontSize="12"
                textAnchor="middle"
              >
                {String(NIGHT_HOURS[index]).padStart(2, "0")}
              </text>
            </g>
          ))}
          <text x="30" y="36" fill="#a3a7c4" fontSize="12">
            {maximum}
          </text>
          <text x="25" y="204" fill="#a3a7c4" fontSize="12">
            0
          </text>
        </svg>
        {night.motion + night.sound === 0 && (
          <p>No received activity for this night.</p>
        )}
      </div>
      <h3 className="night-summary-title">Last seven nights</h3>
      <div className="events-panel">
        <table className="night-summary">
          <thead>
            <tr>
              <th scope="col">Night starting</th>
              <th scope="col">Movement</th>
              <th scope="col">Sound</th>
            </tr>
          </thead>
          <tbody>
            {previousNights(selected).map((key) => (
              <tr key={key}>
                <th scope="row">{key}</th>
                <td>{activity.nights[key]?.motion ?? 0}</td>
                <td>{activity.nights[key]?.sound ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="screen-footnote">
        Counts include events received while this app was connected. Monitoring
        gaps are not measured; zero events do not prove inactivity. Local
        storage keeps up to 90 nights and 500 recent events. Repeated
        daylight-saving hours share one hourly bin.
      </p>
    </section>
  );
}
