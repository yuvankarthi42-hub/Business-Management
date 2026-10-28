// Emoji suggestions for a new category, by business type (Products → Categories → New category).
// The first one is the default for a new category; the shop can still type any other emoji.
import type { Business } from './types'

export interface CategoryEmoji { emoji: string; label: string }

const e = (list: string): CategoryEmoji[] => list.split('|').map((x) => { const [emoji, label] = x.split('='); return { emoji, label } })

const RESTAURANT = e('🍛=Meals|🍚=Biryani & Rice|🫓=Parotta & Breads|🥞=Dosa & Tiffin|🍗=Chicken|🐟=Fish & Seafood|🍖=Mutton|🥗=Starters & Salads|🍜=Noodles & Fried Rice|🍲=Soups & Gravies|🥘=Curries|🌶️=Chinese|🍨=Desserts|🥤=Drinks|☕=Tea & Coffee|🍽️=Combos')
const FAST_FOOD = e('🍔=Burgers|🍕=Pizza|🌯=Rolls & Wraps|🍟=Fries & Sides|🌭=Hot Dogs|🥪=Sandwiches|🍗=Fried Chicken|🍝=Pasta|🍜=Noodles|🥤=Shakes & Drinks|🍦=Ice Cream|🍽️=Combos')
const BAKERY = e('🎂=Cakes|🧁=Cupcakes & Pastries|🍞=Breads|🥐=Puffs & Croissants|🍪=Biscuits & Cookies|🥧=Pies|🍩=Donuts|🍰=Slices|🥖=Buns|🍫=Chocolates|🥤=Drinks|🎉=Party Orders')
const TEA = e('☕=Tea & Coffee|🍵=Special Tea|🧋=Milkshakes|🧃=Juices|🥤=Cool Drinks|🍪=Biscuits|🥟=Snacks|🥪=Sandwiches|🍌=Fruits|🍦=Ice Cream')
const JUICE = e('🧃=Fresh Juices|🥤=Milkshakes|🍹=Mocktails|🍉=Fruit Bowls|🥭=Mango Specials|🍋=Lemon & Soda|🥥=Tender Coconut|🍨=Ice Cream|🍦=Falooda|🧋=Bubble Tea')
const SWEETS = e('🍬=Sweets|🍮=Milk Sweets|🍯=Ghee Sweets|🥮=Laddu & Mysore Pak|🥨=Mixture & Savouries|🍘=Murukku|🥜=Nuts & Dry Fruits|🎁=Gift Boxes|🥟=Snacks|🧈=Ghee & Butter')
const CATERING = e('🍛=Meals|🍚=Rice Varieties|🥘=Curries|🍗=Non-Veg|🥗=Starters|🍮=Desserts|🥤=Drinks|🍽️=Packages|🎉=Function Orders|🍌=Leaf Meals')

const GROCERY = e('🌾=Rice & Grains|🫘=Dal & Pulses|🌶️=Masala & Spices|🛢️=Oil & Ghee|🧂=Salt & Sugar|🥛=Milk & Dairy|🥚=Eggs|🍞=Bread & Bakery|🍪=Biscuits & Snacks|🥤=Beverages|🧴=Personal Care|🧼=Soaps & Detergent|🧹=Home Care|🥬=Vegetables|🍎=Fruits|🍫=Chocolates|🧊=Frozen|🍼=Baby Care')
const TEXTILE = e('🥻=Silk Sarees|👗=Sarees|🧵=Cotton|🪡=Blouse & Materials|👘=Dhoti & Veshti|👔=Shirts|👖=Pants|👚=Chudidhar & Kurtis|🧒=Kids Wear|🧣=Shawls & Dupattas|🛏️=Bed Sheets & Towels|🎁=Wedding Collection|🧶=Fabrics|🩳=Innerwear')
const ELECTRONICS = e('📱=Mobiles|🔌=Chargers & Cables|🎧=Headphones|💡=Lights & Bulbs|📺=TV & Audio|💻=Computers|🔋=Batteries|⌚=Watches|🖨️=Printers|📷=Cameras|🧊=Appliances|🔧=Spares')
const HARDWARE = e('🔩=Nuts & Bolts|🔧=Tools|🪛=Screwdrivers|🪚=Saws & Cutting|🔨=Hammers|🧰=Tool Kits|🔌=Electricals|💡=Lights|🚿=Plumbing|🪣=Paints|🧱=Cement & Building|🪜=Ladders|⛓️=Chains & Ropes|🔒=Locks')
const STATIONERY = e('📒=Notebooks|✏️=Pencils|🖊️=Pens|📐=Geometry|🖍️=Colours & Art|📎=Office|📄=Paper|🎒=Bags|📚=Books|✂️=Scissors & Craft|🧮=Calculators|🎁=Gift Items')
const FANCY = e('💍=Jewellery|💄=Cosmetics|🎀=Hair Accessories|👜=Bags & Purses|🕶️=Sunglasses|⌚=Watches|🧸=Toys|🎁=Gifts|💅=Nail Care|🪞=Mirrors & Combs|👡=Footwear|🧴=Perfumes')
const VEGETABLES = e('🥬=Leafy Greens|🥕=Vegetables|🥔=Potato & Onion|🍅=Tomato|🌶️=Chilli & Ginger|🥒=Gourds|🍆=Brinjal|🌽=Corn & Beans|🍎=Fruits|🍌=Banana|🥭=Mango|🍇=Grapes|🍊=Citrus|🥥=Coconut|🍄=Mushroom|🌿=Herbs & Leaves')
const AUTO = e('🛢️=Engine Oil|🔋=Batteries|🛞=Tyres & Tubes|💡=Lights & Indicators|🔧=Spare Parts|⛓️=Chain Sprocket|🛑=Brakes|🔌=Electricals|🪛=Tools|🧽=Cleaning & Care|🪖=Helmets|🏍️=Bike Accessories|🚗=Car Accessories|🧴=Coolant & Lubes')
const RETAIL = e('🛒=General|📦=Packed Goods|🧴=Personal Care|🧼=Home Care|🥤=Beverages|🍪=Snacks|🎁=Gifts|🧸=Toys|👕=Clothing|🔌=Electricals|📒=Stationery|🏷️=Offers')

const SALON = e('✂️=Haircut|💇=Hair Styling|🧔=Beard & Shave|💆=Facial|💅=Nails|🧖=Spa|💄=Makeup|👰=Bridal|🧴=Hair Treatment|🎨=Hair Colour|🪒=Waxing|🛍️=Products')
const LAUNDRY = e('👕=Wash & Fold|👔=Ironing|🧥=Dry Clean|👗=Sarees|🛏️=Bed Sheets|🧺=Bulk|👟=Shoes|🧸=Soft Toys|⚡=Express|🪡=Repairs')
const REPAIR = e('📱=Mobile Repair|💻=Laptop Repair|📺=TV Repair|❄️=AC & Fridge|🔌=Electrical|🚿=Plumbing|🔧=General Service|🔋=Battery|🖥️=Computer|🧰=Spares')
const GARAGE = e('🔧=General Service|🛢️=Oil Change|🛑=Brake Work|⚙️=Engine Work|🔋=Battery & Electricals|🛞=Tyre & Puncture|🧽=Water Wash|🎨=Painting & Dent|🪛=Spare Parts|🏍️=Bike Service|🚗=Car Service|🚚=Pick-up & Drop')
const SERVICE = e('🛠️=Services|⏱️=Hourly|📦=Packages|🧾=Charges|⚡=Express|🎁=Offers|🧴=Products|📅=Bookings')

/** The emoji choices for this shop's categories (its sub-type first, then its business type). */
export function categoryEmojisFor(b: Pick<Business, 'category' | 'subType'> | null | undefined): CategoryEmoji[] {
  const t = (b?.subType ?? '').toLowerCase()
  switch (b?.category) {
    case 'restaurant': return RESTAURANT
    case 'food':
      if (/bakery|cake/.test(t)) return BAKERY
      if (/tea|coffee/.test(t)) return TEA
      if (/juice/.test(t)) return JUICE
      if (/sweet|snack/.test(t)) return SWEETS
      if (/cater/.test(t)) return CATERING
      return FAST_FOOD
    case 'retail':
      if (/silk|saree|sari|textile|fabric|garment|cloth|readymade|boutique|apparel/.test(t)) return TEXTILE
      if (/vegetable|fruit|greens|sabzi|kaikari/.test(t)) return VEGETABLES
      if (/auto|spare|motor|vehicle|tyre|tire/.test(t)) return AUTO
      if (/grocery|maligai|supermarket|kirana|provision/.test(t)) return GROCERY
      if (/electronic|mobile/.test(t)) return ELECTRONICS
      if (/hardware|paint|electrical/.test(t)) return HARDWARE
      if (/stationery|book/.test(t)) return STATIONERY
      if (/fancy|gift|cosmetic/.test(t)) return FANCY
      return RETAIL
    case 'service':
      if (/salon|spa|beauty|parlour/.test(t)) return SALON
      if (/laundry|dry ?clean|iron/.test(t)) return LAUNDRY
      if (/garage|vehicle|bike|car|auto|mechanic/.test(t)) return GARAGE
      if (/repair/.test(t)) return REPAIR
      return SERVICE
    default: return RESTAURANT
  }
}
