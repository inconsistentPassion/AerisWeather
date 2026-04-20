/**
 * CitySearch — Searchable city picker with autocomplete.
 * Replaces the dropdown with a text input + filtered results.
 */

export interface City {
  name: string;
  country: string;
  lon: number;
  lat: number;
  population?: number;
}

// Major world cities — sorted by population
export const CITIES: City[] = [
  { name: 'Tokyo', country: 'Japan', lon: 139.69, lat: 35.68, population: 37400000 },
  { name: 'Delhi', country: 'India', lon: 77.21, lat: 28.61, population: 32900000 },
  { name: 'Shanghai', country: 'China', lon: 121.47, lat: 31.23, population: 29200000 },
  { name: 'Beijing', country: 'China', lon: 116.40, lat: 39.90, population: 21500000 },
  { name: 'São Paulo', country: 'Brazil', lon: -46.63, lat: -23.55, population: 22400000 },
  { name: 'Mumbai', country: 'India', lon: 72.88, lat: 19.08, population: 21300000 },
  { name: 'Mexico City', country: 'Mexico', lon: -99.13, lat: 19.43, population: 21900000 },
  { name: 'Osaka', country: 'Japan', lon: 135.50, lat: 34.69, population: 19100000 },
  { name: 'Cairo', country: 'Egypt', lon: 31.24, lat: 30.04, population: 21300000 },
  { name: 'New York', country: 'USA', lon: -74.01, lat: 40.71, population: 18800000 },
  { name: 'Dhaka', country: 'Bangladesh', lon: 90.41, lat: 23.81, population: 22400000 },
  { name: 'Karachi', country: 'Pakistan', lon: 67.01, lat: 24.86, population: 16800000 },
  { name: 'Buenos Aires', country: 'Argentina', lon: -58.38, lat: -34.60, population: 15300000 },
  { name: 'Istanbul', country: 'Turkey', lon: 28.98, lat: 41.01, population: 15600000 },
  { name: 'Kolkata', country: 'India', lon: 88.36, lat: 22.57, population: 15100000 },
  { name: 'Lagos', country: 'Nigeria', lon: 3.39, lat: 6.52, population: 15400000 },
  { name: 'Manila', country: 'Philippines', lon: 120.98, lat: 14.60, population: 14400000 },
  { name: 'Rio de Janeiro', country: 'Brazil', lon: -43.17, lat: -22.91, population: 13600000 },
  { name: 'Guangzhou', country: 'China', lon: 113.26, lat: 23.13, population: 13900000 },
  { name: 'Los Angeles', country: 'USA', lon: -118.24, lat: 34.05, population: 12500000 },
  { name: 'Moscow', country: 'Russia', lon: 37.62, lat: 55.76, population: 12600000 },
  { name: 'Shenzhen', country: 'China', lon: 114.06, lat: 22.54, population: 13400000 },
  { name: 'Lahore', country: 'Pakistan', lon: 74.35, lat: 31.55, population: 13500000 },
  { name: 'Bangalore', country: 'India', lon: 77.59, lat: 12.97, population: 13200000 },
  { name: 'Paris', country: 'France', lon: 2.35, lat: 48.86, population: 11100000 },
  { name: 'Bogotá', country: 'Colombia', lon: -74.07, lat: 4.71, population: 11300000 },
  { name: 'Jakarta', country: 'Indonesia', lon: 106.85, lat: -6.21, population: 11200000 },
  { name: 'Chennai', country: 'India', lon: 80.27, lat: 13.08, population: 11300000 },
  { name: 'Lima', country: 'Peru', lon: -77.04, lat: -12.05, population: 11200000 },
  { name: 'Bangkok', country: 'Thailand', lon: 100.50, lat: 13.76, population: 10700000 },
  { name: 'Seoul', country: 'South Korea', lon: 126.98, lat: 37.57, population: 9900000 },
  { name: 'Nagoya', country: 'Japan', lon: 136.91, lat: 35.18, population: 10200000 },
  { name: 'Hyderabad', country: 'India', lon: 78.49, lat: 17.39, population: 10500000 },
  { name: 'London', country: 'UK', lon: -0.12, lat: 51.51, population: 9500000 },
  { name: 'Tehran', country: 'Iran', lon: 51.39, lat: 35.69, population: 9400000 },
  { name: 'Chicago', country: 'USA', lon: -87.63, lat: 41.88, population: 8900000 },
  { name: 'Chengdu', country: 'China', lon: 104.07, lat: 30.57, population: 9100000 },
  { name: 'Nanjing', country: 'China', lon: 118.80, lat: 32.06, population: 8500000 },
  { name: 'Wuhan', country: 'China', lon: 114.30, lat: 30.59, population: 8400000 },
  { name: 'Ho Chi Minh City', country: 'Vietnam', lon: 106.63, lat: 10.82, population: 9300000 },
  { name: 'Luanda', country: 'Angola', lon: 13.23, lat: -8.84, population: 8900000 },
  { name: 'Ahmedabad', country: 'India', lon: 72.57, lat: 23.02, population: 8600000 },
  { name: 'Kuala Lumpur', country: 'Malaysia', lon: 101.69, lat: 3.14, population: 8400000 },
  { name: 'Hong Kong', country: 'China', lon: 114.17, lat: 22.32, population: 7600000 },
  { name: 'Riyadh', country: 'Saudi Arabia', lon: 46.67, lat: 24.69, population: 7700000 },
  { name: 'Santiago', country: 'Chile', lon: -70.65, lat: -33.44, population: 7000000 },
  { name: 'Singapore', country: 'Singapore', lon: 103.82, lat: 1.35, population: 5900000 },
  { name: 'Shenyang', country: 'China', lon: 123.43, lat: 41.80, population: 8100000 },
  { name: 'Baghdad', country: 'Iraq', lon: 44.37, lat: 33.31, population: 7500000 },
  { name: 'Rangoon', country: 'Myanmar', lon: 96.17, lat: 16.87, population: 5700000 },
  { name: 'Dar es Salaam', country: 'Tanzania', lon: 39.28, lat: -6.79, population: 7400000 },
  { name: 'Abidjan', country: 'Ivory Coast', lon: -4.01, lat: 5.36, population: 5600000 },
  { name: 'Berlin', country: 'Germany', lon: 13.40, lat: 52.52, population: 3700000 },
  { name: 'Madrid', country: 'Spain', lon: -3.70, lat: 40.42, population: 6700000 },
  { name: 'Barcelona', country: 'Spain', lon: 2.17, lat: 41.39, population: 5600000 },
  { name: 'Rome', country: 'Italy', lon: 12.50, lat: 41.90, population: 4300000 },
  { name: 'Dubai', country: 'UAE', lon: 55.27, lat: 25.20, population: 3500000 },
  { name: 'Toronto', country: 'Canada', lon: -79.38, lat: 43.65, population: 6200000 },
  { name: 'Sydney', country: 'Australia', lon: 151.21, lat: -33.87, population: 5400000 },
  { name: 'Melbourne', country: 'Australia', lon: 144.96, lat: -37.81, population: 5200000 },
  { name: 'Johannesburg', country: 'South Africa', lon: 28.05, lat: -26.20, population: 6100000 },
  { name: 'St. Petersburg', country: 'Russia', lon: 30.32, lat: 59.93, population: 5400000 },
  { name: 'Dalian', country: 'China', lon: 121.60, lat: 38.91, population: 5900000 },
  { name: 'Hangzhou', country: 'China', lon: 120.15, lat: 30.27, population: 7200000 },
  { name: 'Surat', country: 'India', lon: 72.83, lat: 21.17, population: 7200000 },
  { name: 'Pune', country: 'India', lon: 73.86, lat: 18.52, population: 6600000 },
  { name: 'Jeddah', country: 'Saudi Arabia', lon: 39.17, lat: 21.54, population: 4700000 },
  { name: 'Taipei', country: 'Taiwan', lon: 121.57, lat: 25.03, population: 2600000 },
  { name: 'Boston', country: 'USA', lon: -71.06, lat: 42.36, population: 4900000 },
  { name: 'Washington DC', country: 'USA', lon: -77.04, lat: 38.91, population: 5400000 },
  { name: 'San Francisco', country: 'USA', lon: -122.42, lat: 37.77, population: 4700000 },
  { name: 'Miami', country: 'USA', lon: -80.19, lat: 25.76, population: 6200000 },
  { name: 'Seattle', country: 'USA', lon: -122.33, lat: 47.61, population: 4000000 },
  { name: 'Phoenix', country: 'USA', lon: -112.07, lat: 33.45, population: 5000000 },
  { name: 'Atlanta', country: 'USA', lon: -84.39, lat: 33.75, population: 6100000 },
  { name: 'Vancouver', country: 'Canada', lon: -123.12, lat: 49.28, population: 2600000 },
  { name: 'Montreal', country: 'Canada', lon: -73.57, lat: 45.50, population: 4300000 },
  { name: 'Mexico City', country: 'Mexico', lon: -99.13, lat: 19.43, population: 21900000 },
  { name: 'Havana', country: 'Cuba', lon: -82.38, lat: 23.11, population: 2100000 },
  { name: 'Lisbon', country: 'Portugal', lon: -9.14, lat: 38.72, population: 2900000 },
  { name: 'Amsterdam', country: 'Netherlands', lon: 4.90, lat: 52.37, population: 1200000 },
  { name: 'Vienna', country: 'Austria', lon: 16.37, lat: 48.21, population: 1900000 },
  { name: 'Prague', country: 'Czech Republic', lon: 14.44, lat: 50.08, population: 1300000 },
  { name: 'Warsaw', country: 'Poland', lon: 21.01, lat: 52.23, population: 1800000 },
  { name: 'Stockholm', country: 'Sweden', lon: 18.07, lat: 59.33, population: 1600000 },
  { name: 'Oslo', country: 'Norway', lon: 10.75, lat: 59.91, population: 1100000 },
  { name: 'Helsinki', country: 'Finland', lon: 24.94, lat: 60.17, population: 1300000 },
  { name: 'Copenhagen', country: 'Denmark', lon: 12.57, lat: 55.68, population: 1400000 },
  { name: 'Brussels', country: 'Belgium', lon: 4.35, lat: 50.85, population: 1200000 },
  { name: 'Zurich', country: 'Switzerland', lon: 8.54, lat: 47.38, population: 420000 },
  { name: 'Athens', country: 'Greece', lon: 23.73, lat: 37.98, population: 3200000 },
  { name: 'Dublin', country: 'Ireland', lon: -6.26, lat: 53.35, population: 1400000 },
  { name: 'Auckland', country: 'New Zealand', lon: 174.76, lat: -36.85, population: 1700000 },
  { name: 'Nairobi', country: 'Kenya', lon: 36.82, lat: -1.29, population: 5100000 },
  { name: 'Casablanca', country: 'Morocco', lon: -7.59, lat: 33.57, population: 3800000 },
  { name: 'Addis Ababa', country: 'Ethiopia', lon: 38.75, lat: 9.02, population: 5200000 },
  { name: 'Accra', country: 'Ghana', lon: -0.19, lat: 5.56, population: 4200000 },
  { name: 'Kiev', country: 'Ukraine', lon: 30.52, lat: 50.45, population: 3000000 },
  { name: 'Bucharest', country: 'Romania', lon: 26.10, lat: 44.43, population: 1800000 },
  { name: 'Cape Town', country: 'South Africa', lon: 18.42, lat: -33.92, population: 4600000 },
  { name: 'Porto Alegre', country: 'Brazil', lon: -51.22, lat: -30.03, population: 4400000 },
  { name: 'Medellín', country: 'Colombia', lon: -75.57, lat: 6.25, population: 4000000 },
  { name: 'Quito', country: 'Ecuador', lon: -78.47, lat: -0.18, population: 2800000 },
  { name: 'La Paz', country: 'Bolivia', lon: -68.15, lat: -16.50, population: 1800000 },
  { name: 'Tashkent', country: 'Uzbekistan', lon: 69.28, lat: 41.30, population: 2500000 },
  { name: 'Almaty', country: 'Kazakhstan', lon: 76.95, lat: 43.24, population: 2100000 },
  { name: 'Colombo', country: 'Sri Lanka', lon: 79.85, lat: 6.93, population: 750000 },
  { name: 'Kathmandu', country: 'Nepal', lon: 85.32, lat: 27.70, population: 1500000 },
  { name: 'Hanoi', country: 'Vietnam', lon: 105.85, lat: 21.03, population: 8200000 },
  { name: 'Phnom Penh', country: 'Cambodia', lon: 104.93, lat: 11.56, population: 2100000 },
  { name: 'Ulaanbaatar', country: 'Mongolia', lon: 106.91, lat: 47.92, population: 1500000 },
  { name: 'Perth', country: 'Australia', lon: 115.86, lat: -31.95, population: 2100000 },
  { name: 'Brisbane', country: 'Australia', lon: 153.03, lat: -27.47, population: 2600000 },
  { name: 'Reykjavik', country: 'Iceland', lon: -21.82, lat: 64.13, population: 130000 },
  { name: 'Anchorage', country: 'USA', lon: -149.90, lat: 61.22, population: 290000 },
  { name: 'Marrakech', country: 'Morocco', lon: -8.00, lat: 31.63, population: 930000 },
  { name: 'Khartoum', country: 'Sudan', lon: 32.53, lat: 15.59, population: 5800000 },
  { name: 'Kinshasa', country: 'DR Congo', lon: 15.27, lat: -4.44, population: 17100000 },
  { name: 'Alexandria', country: 'Egypt', lon: 29.92, lat: 31.20, population: 5400000 },
  { name: 'Surabaya', country: 'Indonesia', lon: 112.75, lat: -7.25, population: 3000000 },
  { name: 'Bandung', country: 'Indonesia', lon: 107.61, lat: -6.91, population: 2500000 },
];

/**
 * Search cities by name (fuzzy, case-insensitive).
 * Returns up to maxResults matches, sorted by relevance.
 */
export function searchCities(query: string, maxResults: number = 8): City[] {
  if (!query.trim()) return [];

  const q = query.toLowerCase().trim();

  // Score each city
  const scored = CITIES.map(city => {
    const name = city.name.toLowerCase();
    const country = city.country.toLowerCase();
    let score = 0;

    // Exact match
    if (name === q) score += 100;
    // Starts with query
    else if (name.startsWith(q)) score += 60;
    // Contains query
    else if (name.includes(q)) score += 30;
    // Country match
    else if (country.includes(q)) score += 15;
    // Fuzzy: check if query chars appear in order
    else {
      let qi = 0;
      for (let ci = 0; ci < name.length && qi < q.length; ci++) {
        if (name[ci] === q[qi]) qi++;
      }
      if (qi === q.length) score += 10;
    }

    // Boost by population (log scale)
    if (score > 0 && city.population) {
      score += Math.log10(city.population) * 2;
    }

    return { city, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.city);
}
