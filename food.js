const config = require("./config");
const pg = require("pg");
pg.defaults.ssl = true;

const query = async q => {
  const pool = new pg.Pool(config.PG_CONFIG);
  const client = await pool.connect(console.log("Connected to database"));
  try {
    return await client.query(q);
  } finally {
    client.release();
  }
};

const readRandomRestaurant = (userFoodType, callback) => {
  query(
    `SELECT * FROM public.restaurants WHERE cuisine = '${userFoodType}' ORDER BY random() LIMIT 1`
  )
    .then(res => {
      let title = res.rows[0].name;
      let description = res.rows[0].description;
      let gmapUrl = res.rows[0].gmap_url;
      let imageUrl = res.rows[0].image_url;
      callback(title, description, gmapUrl, imageUrl);
    })
    .catch(err => console.log(err));
};

module.exports = {
  readRandomRestaurant
};
