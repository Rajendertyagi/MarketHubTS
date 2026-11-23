/**
 * Sanitized, official-format provider master fixtures for WP4A tests.
 * No credentials, tokens or real account data. Field names and value shapes
 * follow the official Upstox BOD JSON and FYERS Symbol Master JSON formats.
 */

export const upstoxRows = [
  {
    segment: "NSE_EQ", name: "RELIANCE INDUSTRIES LTD", exchange: "NSE", isin: "INE002A01018",
    instrument_type: "EQ", instrument_key: "NSE_EQ|INE002A01018", lot_size: 1,
    freeze_quantity: 100000, exchange_token: "2885", tick_size: 0.05,
    trading_symbol: "RELIANCE", short_name: "RELIANCE"
  },
  {
    segment: "NSE_INDEX", name: "NIFTY 50", exchange: "NSE", instrument_type: "INDEX",
    instrument_key: "NSE_INDEX|Nifty 50", exchange_token: "9999", tick_size: 0.05,
    trading_symbol: "NIFTY 50", short_name: "NIFTY"
  },
  {
    segment: "NSE_FO", name: "RELIANCE", exchange: "NSE", instrument_type: "OPTSTK", option_type: "CE",
    instrument_key: "NSE_FO|REL-CE-1", underlying_key: "NSE_EQ|INE002A01018", underlying_type: "EQ",
    expiry: "2026-12-29T15:00:00+05:30", strike_price: 3000, lot_size: 250, tick_size: 0.05,
    freeze_quantity: 10000, trading_symbol: "RELIANCE26DEC3000CE", exchange_token: "111"
  },
  {
    segment: "NSE_FO", name: "NIFTY 50", exchange: "NSE", instrument_type: "OPTIDX", option_type: "PE",
    instrument_key: "NSE_FO|NIFTY-PE-1", underlying_key: "NSE_INDEX|Nifty 50", underlying_type: "INDEX",
    expiry: "2026-12-29T15:00:00+05:30", strike_price: 25000, lot_size: 75, tick_size: 0.05,
    freeze_quantity: 5000, trading_symbol: "NIFTY26DEC25000PE", exchange_token: "222"
  },
  // BSE scopes: cash equity/index underlyings and their FO option contracts.
  {
    segment: "BSE_EQ", name: "TATA CONSULTANCY SERVICES LTD", exchange: "BSE", isin: "INE467B01029",
    instrument_type: "EQ", instrument_key: "BSE_EQ|INE467B01029", lot_size: 1,
    freeze_quantity: 100000, exchange_token: "500325", tick_size: 0.05,
    trading_symbol: "TCS", short_name: "TCS"
  },
  {
    segment: "BSE_INDEX", name: "SENSEX", exchange: "BSE", instrument_type: "INDEX",
    instrument_key: "BSE_INDEX|SENSEX", exchange_token: "9998", tick_size: 0.05,
    trading_symbol: "SENSEX", short_name: "SENSEX"
  },
  {
    segment: "BSE_FO", name: "TCS", exchange: "BSE", instrument_type: "OPTSTK", option_type: "CE",
    instrument_key: "BSE_FO|TCS-CE-1", underlying_key: "BSE_EQ|INE467B01029", underlying_type: "EQ",
    expiry: "2026-12-29T15:00:00+05:30", strike_price: 4000, lot_size: 100, tick_size: 0.05,
    freeze_quantity: 5000, trading_symbol: "TCS26DEC4000CE", exchange_token: "333"
  },
  {
    segment: "BSE_FO", name: "SENSEX", exchange: "BSE", instrument_type: "OPTIDX", option_type: "PE",
    instrument_key: "BSE_FO|SENSEX-PE-1", underlying_key: "BSE_INDEX|SENSEX", underlying_type: "INDEX",
    expiry: "2026-12-29T15:00:00+05:30", strike_price: 80000, lot_size: 15, tick_size: 0.05,
    freeze_quantity: 3000, trading_symbol: "SENSEX26DEC80000PE", exchange_token: "444"
  },
  // Out-of-scope rows: futures, currency, commodity, unrelated exchange.
  {
    segment: "NSE_FO", name: "RELIANCE", exchange: "NSE", instrument_type: "FUTSTK",
    instrument_key: "NSE_FO|REL-FUT-1", underlying_key: "NSE_EQ|INE002A01018", underlying_type: "EQ",
    expiry: "2026-12-29T15:00:00+05:30", lot_size: 250, tick_size: 0.05, trading_symbol: "RELIANCE26DECFUT"
  },
  {
    segment: "NSE_CD", name: "USDINR", exchange: "NSE", instrument_type: "CE",
    instrument_key: "NSE_CD|USD-CE-1", underlying_key: "NSE_CD|USDINR", underlying_type: "CURRENCY",
    expiry: "2026-12-29T15:00:00+05:30", strike_price: 90, trading_symbol: "USDINR26DEC90CE"
  },
  {
    segment: "MCX_FO", name: "GOLD", exchange: "MCX", instrument_type: "CE",
    instrument_key: "MCX_FO|GOLD-CE-1", underlying_key: "MCX_FO|GOLD", underlying_type: "COMMODITY",
    expiry: "2026-12-29T15:00:00+05:30", strike_price: 50000, trading_symbol: "GOLD26DEC50000CE"
  }
];

export const fyersFiles = {
  NSE_CM: {
    "NSE:RELIANCE-EQ": {
      fyToken: "101000000015982", exToken: 15982, exSymbol: "RELIANCE", exSeries: "EQ",
      symTicker: "NSE:RELIANCE-EQ", exchangeName: "NSE", optType: "XX", isin: "INE002A01018",
      tradeStatus: 1, lastUpdate: "2026-11-23", symDetails: "Reliance Industries Ltd"
    },
    "NSE:NIFTY50-INDEX": {
      fyToken: "101000000026009", exToken: 26009, exSymbol: "NIFTY", exSeries: "XX",
      symTicker: "NSE:NIFTY50-INDEX", exchangeName: "NSE", optType: "XX", isin: "",
      tradeStatus: 1, lastUpdate: "2026-11-23", symDetails: "NIFTY 50"
    },
    "NSE:UNUSED-EQ": {
      fyToken: "101000000099999", exToken: 99999, exSymbol: "UNUSED", exSeries: "EQ",
      symTicker: "NSE:UNUSED-EQ", exchangeName: "NSE", optType: "XX", isin: "INE999A01019",
      tradeStatus: 1, lastUpdate: "2026-11-23"
    }
  },
  NSE_FO: {
    "NSE:RELIANCE26DEC3000CE": {
      fyToken: "1011270223158568", exToken: 158568, exSymbol: "RELIANCE",
      symTicker: "NSE:RELIANCE26DEC3000CE", exchangeName: "NSE", optType: "CE",
      underSym: "RELIANCE", underFyTok: "101000000015982", expiryDate: "1798539000",
      strikePrice: 3000, minLotSize: 250, tickSize: 0.05, qtyFreeze: "10000",
      tradeStatus: 1, lastUpdate: "2026-11-23", symDetails: "29 Dec 26 3000 CE"
    },
    "NSE:NIFTY26DEC25000PE": {
      fyToken: "1011270223158569", exToken: 158569, exSymbol: "NIFTY",
      symTicker: "NSE:NIFTY26DEC25000PE", exchangeName: "NSE", optType: "PE",
      underSym: "NIFTY", underFyTok: "101000000026009", expiryDate: "1798539000",
      strikePrice: 25000, minLotSize: 75, tickSize: 0.05, qtyFreeze: "5000",
      tradeStatus: 1, lastUpdate: "2026-11-23", symDetails: "29 Dec 26 25000 PE"
    },
    "NSE:RELIANCE26DEC3100PE": {
      fyToken: "1011270223158570", exToken: 158570, exSymbol: "RELIANCE",
      symTicker: "NSE:RELIANCE26DEC3100PE", exchangeName: "NSE", optType: "PE",
      underSym: "RELIANCE", underFyTok: "101000000015982", expiryDate: "1798539000",
      strikePrice: 3100, minLotSize: 250, tickSize: 0.05, qtyFreeze: "10000",
      tradeStatus: 0, lastUpdate: "2026-11-23", symDetails: "29 Dec 26 3100 PE"
    },
    "NSE:RELIANCE26DECFUT": {
      fyToken: "101126122958872", exToken: 58872, exSymbol: "RELIANCE",
      symTicker: "NSE:RELIANCE26DECFUT", exchangeName: "NSE", optType: "XX",
      underSym: "RELIANCE", underFyTok: "101000000015982", expiryDate: "1798539000",
      strikePrice: -1, minLotSize: 250, tickSize: 0.05, qtyFreeze: "10000",
      tradeStatus: 1, lastUpdate: "2026-11-23"
    }
  },
  BSE_CM: {
    "BSE:TCS-EQ": {
      fyToken: "101000000020001", exToken: 20001, exSymbol: "TCS", exSeries: "EQ",
      symTicker: "BSE:TCS-EQ", exchangeName: "BSE", optType: "XX", isin: "INE467B01029",
      tradeStatus: 1, lastUpdate: "2026-11-23", symDetails: "Tata Consultancy Services Ltd"
    },
    "BSE:SENSEX-INDEX": {
      fyToken: "101000000020002", exToken: 20002, exSymbol: "SENSEX", exSeries: "XX",
      symTicker: "BSE:SENSEX-INDEX", exchangeName: "BSE", optType: "XX", isin: "",
      tradeStatus: 1, lastUpdate: "2026-11-23", symDetails: "SENSEX"
    }
  },
  BSE_FO: {
    "BSE:TCS26DEC4000CE": {
      fyToken: "1011270223158600", exToken: 158600, exSymbol: "TCS",
      symTicker: "BSE:TCS26DEC4000CE", exchangeName: "BSE", optType: "CE",
      underSym: "TCS", underFyTok: "101000000020001", expiryDate: "1798539000",
      strikePrice: 4000, minLotSize: 100, tickSize: 0.05, qtyFreeze: "5000",
      tradeStatus: 1, lastUpdate: "2026-11-23", symDetails: "29 Dec 26 4000 CE"
    },
    "BSE:SENSEX26DEC80000PE": {
      fyToken: "1011270223158601", exToken: 158601, exSymbol: "SENSEX",
      symTicker: "BSE:SENSEX26DEC80000PE", exchangeName: "BSE", optType: "PE",
      underSym: "SENSEX", underFyTok: "101000000020002", expiryDate: "1798539000",
      strikePrice: 80000, minLotSize: 15, tickSize: 0.05, qtyFreeze: "3000",
      tradeStatus: 1, lastUpdate: "2026-11-23", symDetails: "29 Dec 26 80000 PE"
    }
  }
} as const;
