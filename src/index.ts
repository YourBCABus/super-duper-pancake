import fs from 'fs';
import path from 'path';

import { createClient, DirectionsResponse } from '@google/maps';
import rp from 'request-promise-native';
import {DateTime} from "luxon";

interface IDObject {
  _id: string;
}

interface NameObject extends IDObject {
  name?: string;
}

interface Coordinate {
  latitude: number;
  longitude: number;
}

interface LocationObject extends IDObject {
  location: Coordinate;
}

interface School extends LocationObject {
  timezone?: string;
}

interface Stop extends NameObject, LocationObject {
  order: number;
}

interface DismissalData {
  ok: boolean;
  found: boolean;
  departure_time?: number;
}

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../config.json"), "utf8"));
const batchSize = 10;

const client = createClient({key: config.key});

async function fetchFromGoogleMaps() {
  let school: School = await rp(`https://db.yourbcabus.com/schools/${config.school}`, {json: true});
  let timezone = school.timezone || "UTC";

  const now = DateTime.local().setZone(timezone);
  let dismissal: DismissalData = await rp(`https://db.yourbcabus.com/schools/${config.school}/dismissal`, {
    qs: {date: now.toSeconds()},
    json: true
  });

  let departureDate = (dismissal.departure_time === 0 || dismissal.departure_time) ? now.set({
    hour: Math.floor(dismissal.departure_time / 3600),
    minute: Math.floor(dismissal.departure_time / 60) % 60,
    second: dismissal.departure_time % 60,
    millisecond: 0
  }) : now.set({
    hour: 16,
    minute: 30,
    second: 0,
    millisecond: 0
  });

  let invalidateDate = now.set({hour: 0, minute: 0, second: 0, millisecond: 0}).plus({days: 1});

  if (school.location) {
    let buses: NameObject[] = await rp(`https://db.yourbcabus.com/schools/${config.school}/buses`, {json: true});
    while (buses.length > 0) {
      const batch = buses.splice(0, batchSize);
      await Promise.all(batch.map(async bus => {
        const stops = ((await rp(`https://db.yourbcabus.com/schools/${config.school}/buses/${bus._id}/stops`, {json: true})) as Stop[]).sort((a, b) => {
          if (a.order === b.order) {
            return 0;
          } else if (a.order < b.order) {
            return -1;
          } else {
            return 1;
          }
        });
        if (stops.length > 0) {
          const results = await Promise.all([school].concat(stops).slice(0, -1).map((stop, index) => new Promise<DirectionsResponse>((resolve, reject) => {
            client.directions({
              origin: [stop.location.latitude, stop.location.longitude],
              destination: [stops[index].location.latitude, stops[index].location.longitude],
              mode: "driving",
              departure_time: departureDate.toJSDate()
            }, (err, res) => {
              err ? reject(err) : resolve(res.json);
            });
          })));

          let i;
          let perStopDelay = 40;
          let previousDate = new Date(departureDate.toMillis() - perStopDelay * 1000);
          for (i = 0; i < stops.length; i++) {
            if (results[i].routes.length > 0 && results[i].routes[0].legs.length > 0) {
              previousDate = new Date(previousDate.getTime() + results[i].routes[0].legs[0].duration_in_traffic.value * 1000 + perStopDelay * 1000);
              await rp.patch(`https://db.yourbcabus.com/schools/${config.school}/buses/${bus._id}/stops/${stops[i]._id}`, {
                json: {arrival_time: previousDate, invalidate_time: invalidateDate},
                headers: {Authorization: `Basic ${config.token}`}
              });
            }
          }

          console.log(`Updated ${bus.name}`);
        }
      }));
    }
  }
}

fetchFromGoogleMaps().then(() => {
  console.log("Done");
});
