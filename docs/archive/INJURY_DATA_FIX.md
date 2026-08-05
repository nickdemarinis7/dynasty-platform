# Injury Data Fix - Re-Import Required

## ✅ What Was Fixed

Added `injury_status` extraction from Sleeper API to populate injury badges and lineup impact calculations.

**Files Modified:**
1. `src/lib/sleeper-api.ts` - Added `injury_status` field to player type
2. `src/app/api/sleeper/import/route.ts` - Extract and store `injury_status` from Sleeper data

---

## 🔄 **ACTION REQUIRED: Re-Import Your League**

The injury data is now being fetched from Sleeper, but your current league data doesn't have it yet. You need to re-import:

### **Steps:**

1. **Navigate to League Page**
   - Go to http://localhost:3000/league

2. **Re-Import League**
   - Click "Import from Sleeper" button
   - Enter your username: `nickdemarinis`
   - Select "QB Controversy" league
   - Click Import

3. **Verify Injury Data**
   - Go to `/recommendations`
   - Look for players with injury status
   - You should now see red badges: [OUT], [Q], [IR], etc.

---

## 📊 **What Injury Statuses Are Supported**

Sleeper provides these injury statuses:

| Sleeper Status | Display | Points Penalty |
|----------------|---------|----------------|
| `Out` | OUT | 100% (0 points) |
| `Questionable` | Q | 15% reduction |
| `Doubtful` | D | 70% reduction |
| `IR` | IR | 100% (0 points) |
| `PUP` | PUP | 100% (0 points) |
| `Suspended` | SUS | 100% (0 points) |
| `COV` | COV | 100% (0 points) |

---

## 🧪 **Test Case: Ricky Pearsall**

**Before Fix:**
```
Recommendation: Send Ricky Pearsall → Get T.J. Hockenson
No injury badge shown
Projected as if healthy
```

**After Fix + Re-Import:**
```
Recommendation: Send Ricky Pearsall [OUT] → Get T.J. Hockenson
Red "OUT" badge visible
Projected points: 0 (injured)
Lineup impact: Accurate (trading away injured player)
```

---

## 🔍 **How to Verify It's Working**

### **1. Check Raw Data**
After re-import, open browser console and check:
```javascript
// In browser console
const store = JSON.parse(localStorage.getItem('dynasty-trade-sim'));
const player = store.state.rosters[0].players.find(p => p.name === 'Ricky Pearsall');
console.log(player.injuryStatus); // Should show "Out" or similar
```

### **2. Check UI**
- Navigate to `/recommendations`
- Find any trade involving Ricky Pearsall
- Should see red [OUT] badge next to his name

### **3. Check Lineup Impact**
- Injured players should have 0 projected points
- Lineup optimizer should bench them automatically
- Trade recommendations should reflect injury in PPG calculations

---

## 🚨 **Important Notes**

1. **Injury data is live from Sleeper** - It updates when you re-import
2. **You must re-import** to get current injury statuses
3. **Sleeper updates injury data** - Re-import weekly during season for latest status
4. **Off-season** - Injury statuses may be stale or cleared

---

## 🔮 **Future Enhancement**

**Auto-refresh injury data:**
- Add background job to refresh injury statuses daily
- Don't require full league re-import
- Just update player injury fields

**For now:** Re-import league when you want latest injury data.

---

## ✅ **Summary**

**What changed:**
- ✅ Sleeper API now fetches `injury_status` field
- ✅ Import route stores it in Player objects
- ✅ Lineup optimizer uses it for projections
- ✅ UI displays it as red badges

**What you need to do:**
- 🔄 Re-import your league to populate injury data
- ✅ Verify Ricky Pearsall shows [OUT] badge
- ✅ Test that injured players have 0 projected points

**Status:** Ready to test after re-import!
