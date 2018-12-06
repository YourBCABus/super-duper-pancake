import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { createClient, DirectionsResponse } from '@google/maps';
import rp from 'request-promise-native';

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

interface Stop extends NameObject, LocationObject {
  order: number;
}

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../config.json"), "utf8"));
const batchSize = 10;

const client = createClient({key: config.key});

let departureDate = new Date();
departureDate.setHours(parseInt(process.argv[2]));
departureDate.setMinutes(parseInt(process.argv[3]));
departureDate.setSeconds(0);
departureDate.setMilliseconds(0);

let invalidateDate = new Date(departureDate.getFullYear(), departureDate.getMonth(), departureDate.getDate() + 1, 0, 0, 0, 0);

async function fetchFromGoogleMaps() {
  let school: LocationObject = await rp(`https://db.yourbcabus.com/schools/${config.school}`, {json: true});
  if (school.location) {
    let buses: NameObject[] = await rp(`https://db.yourbcabus.com/schools/${config.school}/buses`, {json: true});
    while (buses.length > 0) {
      const batch = buses.splice(0, 10);
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
              departure_time: departureDate
            }, (err, res) => {
              err ? reject(err) : resolve(res.json);
            });
          })));

          let i;
          let perStopDelay = 25;
          let previousDate = new Date(departureDate.getTime() - perStopDelay * 1000);
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

fetchFromGoogleMaps();
